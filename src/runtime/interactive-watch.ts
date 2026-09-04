import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import {
	closeSurface,
	consumeSubagentExitSignal,
	pollForExit,
} from "../mux.ts";
import type { PollResult } from "../mux/poll.ts";
import type { RunningSubagent, SubagentResult, SubagentSummarySource } from "../types.ts";
import { findLastSubagentOutputWithSource, getNewEntries } from "../session/session.ts";
import { traceSubagentLaunch } from "../launch/trace.ts";

export interface InteractiveWatchRuntime {
	cleanupNoSessionSessionFile(running: RunningSubagent): void;
}

export function selectInteractiveCompletion(
	polled: PollResult,
	sidecar: PollResult | null,
): PollResult {
	return sidecar ?? polled;
}

export async function watchSubagent(
	running: RunningSubagent,
	runtime: InteractiveWatchRuntime,
	signal: AbortSignal,
): Promise<SubagentResult> {
	const { name, task, surface, startTime, sessionFile } = running;
	if (!surface)
		throw new Error("watchSubagent called on a background agent (no surface)");

	try {
		traceSubagentLaunch("interactive.watch.start", { name, surface, sessionFile, signalAborted: signal.aborted });
		const pollResult = await pollForExit(surface, signal, {
			interval: 1000,
			sessionFile,
			doneSentinelFile: running.doneSentinelFile,
			onTick() {
				try {
					if (existsSync(sessionFile)) {
						const stat = statSync(sessionFile);
						const raw = readFileSync(sessionFile, "utf8");
						running.entries = raw
							.split("\n")
							.filter((line) => line.trim()).length;
						running.bytes = stat.size;
					}
				} catch {}
			},
		});

		traceSubagentLaunch("interactive.watch.pollResult", { name, surface, sessionFile, pollResult });
		// A shell sentinel can win the poll just before the child atomically publishes
		// its richer sidecar. If it is already available, use that one result for all
		// completion fields rather than mixing two protocols.
		const completion = selectInteractiveCompletion(
			pollResult,
			pollResult.signal === undefined
				? consumeSubagentExitSignal(sessionFile)
				: null,
		);
		const elapsed = Math.floor((Date.now() - startTime) / 1000);
		const { summary, summarySource } = getSummary(running, completion);

		const errorMessage =
			completion.reason === "error" ? completion.errorMessage : undefined;
		cleanupDoneSentinel(running);
		try {
			closeSurface(surface);
		} catch {}
		runtime.cleanupNoSessionSessionFile(running);

		return {
			name,
			task,
			summary,
			summarySource,
			sessionFile: running.noSession ? undefined : sessionFile,
			exitCode: completion.exitCode,
			elapsed,
			outputTokens: completion.outputTokens,
			ping: completion.ping,
			errorMessage,
			exitSignal: completion.signal,
		};
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		traceSubagentLaunch("interactive.watch.error", { name, surface, sessionFile, errorMessage, signalAborted: signal.aborted });
		cleanupDoneSentinel(running);
		try {
			closeSurface(surface);
		} catch {}
		runtime.cleanupNoSessionSessionFile(running);

		if (signal.aborted) {
			return {
				name,
				task,
				summary: "Subagent cancelled.",
				summarySource: "runtime",
				exitCode: 1,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				outputTokens: 0,
				error: "cancelled",
			};
		}
		return {
			name,
			task,
			summary: `Subagent error: ${errorMessage}`,
			summarySource: "runtime",
			exitCode: 1,
			elapsed: Math.floor((Date.now() - startTime) / 1000),
			outputTokens: 0,
			error: errorMessage,
		};
	}
}

function getSummary(
	running: RunningSubagent,
	completion: PollResult,
): { summary: string; summarySource: SubagentSummarySource } {
	if (!running.noSession && existsSync(running.sessionFile)) {
		const allEntries = getNewEntries(
			running.sessionFile,
			running.launchEntryCount ?? 0,
		);
		const output = findLastSubagentOutputWithSource(allEntries);
		if (output) return output;
	}
	return {
		summary: completion.exitCode !== 0
			? `Sub-agent exited with code ${completion.exitCode}`
			: "Sub-agent exited without output",
		summarySource: "runtime",
	};
}

function cleanupDoneSentinel(running: RunningSubagent): void {
	if (!running.doneSentinelFile || !existsSync(running.doneSentinelFile)) return;
	try {
		rmSync(running.doneSentinelFile, { force: true });
	} catch {}
}
