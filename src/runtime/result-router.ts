import type {
	CompletedSubagentResult,
	RunningSubagent,
	SubagentPingMessageDetails,
	SubagentResult,
} from "../types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildCompletedSubagentResult,
	cacheCompletedSubagentResult,
	clearSubagentShutdownTimer,
	describeFailedResultBody,
	runningSubagents,
	stopAfterCurrentSubagentBatch,
} from "./state.ts";

type ParentMessageSink = Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;

// Session-entry reader for delivery verification. Registered by the parent
// extension on session_start; returns undefined when unavailable (tests,
// pre-registration) so verification stays silent instead of escalating blindly.
type SessionEntriesReader = () => unknown[] | undefined;
let sessionEntriesReader: SessionEntriesReader | undefined;

export function setSessionEntriesReader(reader: SessionEntriesReader | undefined): void {
	sessionEntriesReader = reader;
}

function entryDelivered(id: string): boolean | undefined {
	const entries = sessionEntriesReader?.();
	if (entries === undefined) return undefined;
	return entries.some((entry) => {
		const e = entry as { type?: string; customType?: string; details?: { id?: string } } | undefined;
		return (
			e?.type === "custom_message" &&
			e?.customType === "subagent_result" &&
			e?.details?.id === id
		);
	});
}

const DELIVERY_CHECK_DELAYS_MS = [8_000, 25_000];

function sessionRefFor(completed: CompletedSubagentResult): string {
	return completed.sessionFile
		? `\n\nSession: ${completed.sessionFile}\nResume: pi --session ${completed.sessionFile}`
		: "";
}

/**
 * Re-send a completion as a direct user message when the routed custom message
 * never persisted. Covers the known silent-loss paths: sendMessage rejections
 * (model/auth errors at trigger time), nextTurn-queued results whose turn never
 * comes, and steers consumed by a run that had just ended. sendUserMessage
 * always starts (or steers into) a live turn and flushes queued nextTurn
 * messages, so the report cannot vanish. Returns true when it escalated.
 * Throws if sendUserMessage throws — the scheduler catches; direct callers
 * that must not throw should do the same.
 */
export function escalateIfUndelivered(
	pi: ParentMessageSink,
	completed: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
): boolean {
	// "steer" here covers both steer and nextTurn deliveries —
	// deliverCompletedSubagentResult assigns it before routing either way;
	// wait/blocking claims overwrite it with "wait" and must never escalate.
	if (completed.deliveredTo !== "steer") return false;
	if (entryDelivered(completed.id) !== false) return false; // landed, or unverifiable
	pi.sendUserMessage(
		`${getCompletedSubagentContent(completed, formatElapsed, sessionRefFor(completed))}` +
			`\n\n(Delivery check: the routed result never reached this session, so it is resent here.)`,
		{ deliverAs: "steer" },
	);
	return true;
}

function scheduleDeliveryVerification(
	pi: ParentMessageSink,
	completed: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
): void {
	let escalated = false; // escalation itself persists a user message, invisible to entryDelivered
	for (const delay of DELIVERY_CHECK_DELAYS_MS) {
		const timer = setTimeout(() => {
			if (escalated) return;
			try {
				escalated = escalateIfUndelivered(pi, completed, formatElapsed);
			} catch {
				// Never let the guard crash the routing path.
			}
		}, delay);
		timer.unref?.();
	}
}

export interface RouteSubagentOutcomeOptions {
	pi: ParentMessageSink;
	running: RunningSubagent;
	result: SubagentResult;
	formatElapsed(elapsed: number): string;
	updateWidget(): void;
}

interface RoutedCompletionOutcome {
	kind: "completion";
	completed: CompletedSubagentResult;
}

interface RoutedPingOutcome {
	kind: "ping";
	delivered: boolean;
}

export type RoutedSubagentOutcome = RoutedCompletionOutcome | RoutedPingOutcome;

export function routeSubagentOutcome(
	options: RouteSubagentOutcomeOptions,
): RoutedSubagentOutcome {
	const { pi, running, result, formatElapsed, updateWidget } = options;
	clearSubagentShutdownTimer(running);
	if (result.ping) {
		runningSubagents.delete(running.id);
		updateWidget();
		if (running.allowSteerDelivery === false) {
			return { kind: "ping", delivered: false };
		}
		deliverSubagentPing(pi, running, result, formatElapsed);
		return { kind: "ping", delivered: true };
	}
	const completed = running.allowSteerDelivery === false && !running.resultOwner
		? buildCompletedSubagentResult(running, result)
		: cacheCompletedSubagentResult(running, result);
	runningSubagents.delete(running.id);
	updateWidget();
	if (running.allowSteerDelivery === false) {
		return { kind: "completion", completed };
	}
	return {
		kind: "completion",
		completed: deliverCompletedSubagentResult(pi, completed, formatElapsed),
	};
}

export function deliverCompletedSubagentResult(
	pi: ParentMessageSink,
	completed: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
): CompletedSubagentResult {
	if (completed.deliveryState !== "detached" || completed.deliveredTo) {
		return completed;
	}

	const deliverAs = stopAfterCurrentSubagentBatch ? "nextTurn" : "steer";
	completed.deliveredTo = "steer";
	const sessionRef = sessionRefFor(completed);
	pi.sendMessage(
		{
			customType: "subagent_result",
			content: getCompletedSubagentContent(completed, formatElapsed, sessionRef),
			display: true,
			details: {
				id: completed.id,
				name: completed.name,
				task: completed.task,
				agent: completed.agent,
				mode: completed.mode,
				status: completed.status,
				deliveryState: completed.deliveryState,
				parentClosePolicy: completed.parentClosePolicy,
				blocking: completed.blocking,
				async: completed.async,
				exitCode: completed.exitCode,
				elapsed: completed.elapsed,
				outputTokens: completed.outputTokens,
				sessionFile: completed.sessionFile,
				...(completed.errorMessage ? { errorMessage: completed.errorMessage } : {}),
			},
		},
		{ triggerTurn: true, deliverAs },
	);
	scheduleDeliveryVerification(pi, completed, formatElapsed);
	return completed;
}

function deliverSubagentPing(
	pi: ParentMessageSink,
	running: RunningSubagent,
	result: SubagentResult,
	formatElapsed: (elapsed: number) => string,
): void {
	if (!result.ping) return;
	const sessionRef = result.sessionFile
		? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
		: "";
	pi.sendMessage(
		{
			customType: "subagent_ping",
			content:
				`Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}).\n\n` +
				`${result.ping.message}${sessionRef}`,
			display: true,
			details: {
				id: running.id,
				name: result.ping.name,
				task: running.task,
				agent: running.agent,
				mode: running.mode,
				deliveryState: running.deliveryState,
				parentClosePolicy: running.parentClosePolicy,
				blocking: running.blocking,
				async: running.async ?? !running.blocking,
				elapsed: result.elapsed,
				outputTokens: result.outputTokens,
				sessionFile: result.sessionFile,
				message: result.ping.message,
			} as SubagentPingMessageDetails,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function getCompletedSubagentContent(
	completed: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
	sessionRef: string,
): string {
	// State the arrival explicitly: after an async launch the parent's turn is
	// terminated mid-plan, so without this framing models have resumed their
	// stale "waiting for the report" plan and ignored the injected findings.
	const arrival =
		`This is the completed report from sub-agent "${completed.name}" — it has ` +
		`finished; do not wait for further output. Act on it now.\n\n`;
	if (completed.errorMessage) {
		return (
			`${arrival}Sub-agent "${completed.name}" failed after ${formatElapsed(completed.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${completed.errorMessage}\n\n${describeFailedResultBody(completed)}${sessionRef}`
		);
	}
	return completed.exitCode !== 0
		? `${arrival}Sub-agent "${completed.name}" failed (exit ${completed.exitCode}).\n\n${completed.summary}${sessionRef}`
		: `${arrival}Sub-agent "${completed.name}" completed (${formatElapsed(completed.elapsed)}).\n\n${completed.summary}${sessionRef}`;
}
