import { isRetryableProviderErrorMessage } from "../auto-exit.ts";
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
	return isRetryableProviderErrorMessage(result.errorMessage);
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
 * Watch a background child, silently respawning it on transient provider errors
 * until it succeeds or the retry budget is exhausted. A background `pi -p` child
 * is single-shot and cannot self-revive (it disposes as soon as the prompt
 * resolves on error), so transient-error recovery has to happen here in the
 * parent.
 *
 * `timeoutSeconds` bounds the WHOLE run, not each attempt: each respawn gets only
 * the seconds remaining on the original deadline, and a retry is not started if
 * its backoff alone would blow the deadline. Returns the final result — success,
 * or the last failure once the budget is gone.
 */
export async function watchBackgroundSubagentWithRetry(
	running: RunningSubagent,
	deps: BackgroundRetryDeps,
	signal: AbortSignal,
	timeoutSeconds?: number,
	retryDelaysMs: readonly number[] = resolveBackgroundRetryPolicy(),
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
	for (const delay of retryDelaysMs) {
		if (signal.aborted || !isRetryableBackgroundResult(result, running)) {
			return result;
		}
		// Don't start a retry whose backoff alone would exceed the deadline.
		if (deadline !== undefined && Date.now() + delay >= deadline) return result;
		if (!(await abortableSleep(delay, signal))) return result;
		try {
			await deps.respawn(running);
		} catch {
			// Respawn failed (e.g. corrupted session metadata). Surface the
			// original failure rather than masking it with a respawn error.
			return result;
		}
		// The signal may have aborted during the async respawn; the watcher only
		// listens for future aborts, so terminate the just-spawned child here.
		if (signal.aborted) {
			deps.terminate(running);
			return result;
		}
		result = await deps.watch(running, signal, remainingSeconds());
	}
	return result;
}
