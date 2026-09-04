import { shouldRecoverProviderErrorMessage } from "../auto-exit.ts";
import type { RunningSubagent, SubagentResult } from "../types.ts";

/**
 * Per-attempt backoff before respawning a background child after a transient
 * provider error. The list length IS the retry budget (default 2 retries on top
 * of the initial run); an empty list disables retry. Override live with
 * PI_SUBAGENT_BACKGROUND_RETRY_DELAYS_MS.
 */
export const BACKGROUND_RETRY_DELAYS_MS = [30_000, 60_000] as const;
const MIN_BACKGROUND_RETRY_DELAY_MS = 5_000;
const ENV_DELAYS = "PI_SUBAGENT_BACKGROUND_RETRY_DELAYS_MS";

/**
 * Budget for resuming a background child after a threshold compaction. Pi's
 * threshold compaction does not auto-retry and a `pi -p` child cannot self-revive
 * past it, so the child exits with `type: "compacted"` and the parent resumes the
 * session with a "continue" nudge this many times before giving up. Override live
 * with PI_SUBAGENT_MAX_THRESHOLD_CONTINUES; `0` disables.
 */
export const DEFAULT_MAX_THRESHOLD_CONTINUES = 10;
const ENV_MAX_THRESHOLD_CONTINUES = "PI_SUBAGENT_MAX_THRESHOLD_CONTINUES";

export function resolveBackgroundRetryPolicy(
	raw = process.env[ENV_DELAYS],
): readonly number[] {
	if (!raw) return BACKGROUND_RETRY_DELAYS_MS;
	const parsed = raw
		.split(",")
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((ms) => Number.isFinite(ms) && ms >= 0)
		.map((ms) => Math.max(ms, MIN_BACKGROUND_RETRY_DELAY_MS));
	return parsed.length > 0 ? parsed : BACKGROUND_RETRY_DELAYS_MS;
}

export function resolveMaxThresholdContinues(
	raw = process.env[ENV_MAX_THRESHOLD_CONTINUES],
	fallback: number = DEFAULT_MAX_THRESHOLD_CONTINUES,
): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

/**
 * A background result is retryable iff it carries a retryable provider error
 * message and the child has a session file to resume. Non-error exits, pings,
 * crashes without an error sidecar, and noSession children are not retried.
 */
export function isRetryableBackgroundResult(
	result: SubagentResult,
	running: RunningSubagent,
): boolean {
	if (!result.errorMessage) return false;
	if (running.noSession || !running.sessionFile) return false;
	return shouldRecoverProviderErrorMessage(result.errorMessage);
}

/**
 * A background result asks to be resumed with a "continue" nudge after a
 * threshold compaction (the child exited `type: "compacted"`). Requires a
 * session file to resume; noSession children have nothing to resume.
 */
export function isCompactedBackgroundResult(
	result: SubagentResult,
	running: RunningSubagent,
): boolean {
	if (result.exitSignal?.type !== "compacted") return false;
	if (running.noSession || !running.sessionFile) return false;
	return true;
}

export interface BackgroundRetryDeps {
	watch(
		running: RunningSubagent,
		signal: AbortSignal,
		timeoutSeconds?: number,
	): Promise<SubagentResult>;
	respawn(running: RunningSubagent): Promise<void>;
	/** Terminate the freshly spawned child if the signal aborted mid-respawn. */
	terminate(running: RunningSubagent): void;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve(false);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve(false);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Watch a background child, silently resuming it on threshold compaction and
 * retrying on transient provider errors, until it succeeds or both budgets are
 * exhausted. A background `pi -p` child is single-shot and cannot self-revive
 * (it disposes as soon as the prompt resolves), so recovery has to happen here
 * in the parent.
 *
 * Two resume triggers share one respawn path (re-launch on the same session with
 * a "continue" nudge) but have independent budgets:
 *  - threshold compaction (`type: "compacted"`): resume immediately, no backoff.
 *  - transient provider error: resume after the configured backoff.
 *
 * `timeoutSeconds` bounds the WHOLE run, not each attempt: each respawn gets only
 * the seconds remaining on the original deadline, and a resume is not started if
 * its backoff (or, for compaction, a fresh spawn with no time left) would blow
 * the deadline. Returns the final result — success, or the last failure once the
 * relevant budget is gone.
 */
export async function watchBackgroundSubagentWithRetry(
	running: RunningSubagent,
	deps: BackgroundRetryDeps,
	signal: AbortSignal,
	timeoutSeconds?: number,
	retryDelaysMs: readonly number[] = resolveBackgroundRetryPolicy(),
	maxThresholdContinues: number = resolveMaxThresholdContinues(),
): Promise<SubagentResult> {
	const deadline =
		timeoutSeconds !== undefined && timeoutSeconds > 0
			? Date.now() + timeoutSeconds * 1000
			: undefined;
	const remainingSeconds = (): number | undefined => {
		if (deadline === undefined) return undefined;
		return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
	};

	let result = await deps.watch(running, signal, remainingSeconds());
	const errorDelays = [...retryDelaysMs];
	let thresholdBudget = maxThresholdContinues;

	while (!signal.aborted) {
		// Decide whether and how to resume.
		let delayMs: number | undefined;
		let consumingThreshold = false;
		if (isCompactedBackgroundResult(result, running) && thresholdBudget > 0) {
			consumingThreshold = true; // resume immediately after compaction
		} else if (
			isRetryableBackgroundResult(result, running) &&
			errorDelays.length > 0
		) {
			delayMs = errorDelays.shift();
		} else {
			break;
		}

		// Don't start a resume that cannot fit the overall deadline.
		if (deadline !== undefined) {
			const now = Date.now();
			if (delayMs !== undefined ? now + delayMs >= deadline : now >= deadline) {
				break;
			}
		}
		if (delayMs !== undefined && !(await abortableSleep(delayMs, signal))) break;

		try {
			await deps.respawn(running);
		} catch {
			// Respawn failed (e.g. corrupted session metadata). Surface the
			// original result rather than masking it with a respawn error.
			break;
		}
		// The signal may have aborted during the async respawn; the watcher only
		// listens for future aborts, so terminate the just-spawned child here.
		if (signal.aborted) {
			deps.terminate(running);
			break;
		}
		if (consumingThreshold) thresholdBudget--;
		result = await deps.watch(running, signal, remainingSeconds());
	}
	// A compacted result reaching here was not resumed to completion (budget
	// exhausted, no budget, or noSession). Surface it as a failure instead of a
	// silent "done" so the parent knows the task is likely incomplete.
	if (result.exitSignal?.type === "compacted") {
		return {
			...result,
			errorMessage:
				result.errorMessage ??
				"Background child exited at a threshold-compaction boundary and was not resumed to completion; the task may be incomplete.",
		};
	}
	return result;
}
