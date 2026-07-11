import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
	BACKGROUND_RETRY_DELAYS_MS,
	isRetryableBackgroundResult,
	resolveBackgroundRetryPolicy,
	watchBackgroundSubagentWithRetry,
	type BackgroundRetryDeps,
} from "../../src/runtime/background-retry.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";

function bgRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "test",
		name: "test-agent",
		task: "t",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		blocking: false,
		autoExit: true,
		startTime: Date.now(),
		sessionFile: "/tmp/test-session.jsonl",
		noSession: false,
		...overrides,
	} as RunningSubagent;
}

function err(errorMessage: string, overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		name: "test-agent",
		task: "t",
		summary: "",
		sessionFile: "/tmp/test-session.jsonl",
		exitCode: 1,
		elapsed: 0,
		errorMessage,
		...overrides,
	};
}

function ok(summary = "done"): SubagentResult {
	return {
		name: "test-agent",
		task: "t",
		summary,
		sessionFile: "/tmp/test-session.jsonl",
		exitCode: 0,
		elapsed: 0,
	};
}

/** A watch mock that returns queued results in order, clamping to the last. */
function queueingWatch(results: SubagentResult[]) {
	const calls: number[] = [];
	const fn = (running: RunningSubagent, _signal: AbortSignal, timeoutSeconds?: number) => {
		calls.push(timeoutSeconds ?? -1);
		const result = results[Math.min(calls.length - 1, results.length - 1)];
		return Promise.resolve(result);
	};
	return { fn, calls };
}

const flushMicrotasks = async (n = 10) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

function retryDeps(
	watch: BackgroundRetryDeps["watch"],
): BackgroundRetryDeps & { respawns: number; terminates: number } {
	let respawns = 0;
	let terminates = 0;
	return {
		watch,
		respawn: async () => {
			respawns++;
		},
		terminate: () => {
			terminates++;
		},
		get respawns() {
			return respawns;
		},
		get terminates() {
			return terminates;
		},
	};
}

describe("resolveBackgroundRetryPolicy", () => {
	it("defaults to 2 retries at 30s/60s", () => {
		assert.deepEqual(resolveBackgroundRetryPolicy(undefined), [30_000, 60_000]);
		assert.deepEqual(BACKGROUND_RETRY_DELAYS_MS, [30_000, 60_000]);
	});

	it("parses a comma-separated override for live tests", () => {
		assert.deepEqual(resolveBackgroundRetryPolicy("5000,10000"), [5000, 10000]);
	});

	it("clamps override delays above a minimum to avoid hot-looping respawns", () => {
		const policy = resolveBackgroundRetryPolicy("100,200");
		assert.ok(policy.every((ms) => ms >= 5000));
	});

	it("ignores junk and falls back to defaults", () => {
		assert.deepEqual(resolveBackgroundRetryPolicy("junk,,"), [30_000, 60_000]);
	});
});

describe("isRetryableBackgroundResult", () => {
	it("retries a retryable provider error on a session-backed child", () => {
		assert.equal(isRetryableBackgroundResult(err("WebSocket error"), bgRunning()), true);
	});

	it("does not retry a non-retryable error (quota/billing)", () => {
		assert.equal(isRetryableBackgroundResult(err("insufficient_quota: billing"), bgRunning()), false);
	});

	it("does not retry a result without an error message (crash without sidecar)", () => {
		assert.equal(isRetryableBackgroundResult(ok(), bgRunning()), false);
	});

	it("does not retry a noSession child (nothing to resume)", () => {
		assert.equal(isRetryableBackgroundResult(err("WebSocket error"), bgRunning({ noSession: true })), false);
	});

	it("does not retry a child without a session file", () => {
		assert.equal(isRetryableBackgroundResult(err("WebSocket error"), bgRunning({ sessionFile: undefined })), false);
	});
});

describe("watchBackgroundSubagentWithRetry", () => {
	it("returns immediately on first-attempt success without respawning", async () => {
		const watch = queueingWatch([ok()]);
		const deps = retryDeps(watch.fn);
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, new AbortController().signal, undefined, [5, 5]);
		assert.equal(result.errorMessage, undefined);
		assert.equal(deps.respawns, 0);
		assert.equal(deps.terminates, 0);
	});

	it("does not retry a non-retryable error", async () => {
		const watch = queueingWatch([err("insufficient_quota")]);
		const deps = retryDeps(watch.fn);
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, new AbortController().signal, undefined, [5, 5]);
		assert.equal(result.errorMessage, "insufficient_quota");
		assert.equal(deps.respawns, 0);
	});

	it("respawns once and returns success when the second attempt succeeds", async () => {
		const watch = queueingWatch([err("WebSocket error"), ok("recovered")]);
		const deps = retryDeps(watch.fn);
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, new AbortController().signal, undefined, [5, 5]);
		assert.equal(result.summary, "recovered");
		assert.equal(deps.respawns, 1);
		assert.equal(watch.calls.length, 2);
	});

	it("exhausts the budget and returns the last failure", async () => {
		const watch = queueingWatch([err("WebSocket error"), err("WebSocket error"), err("WebSocket error")]);
		const deps = retryDeps(watch.fn);
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, new AbortController().signal, undefined, [5, 5]);
		assert.equal(result.errorMessage, "WebSocket error");
		assert.equal(deps.respawns, 2);
		assert.equal(watch.calls.length, 3);
	});

	it("does not retry when the delay list is empty (natural opt-out)", async () => {
		const watch = queueingWatch([err("WebSocket error")]);
		const deps = retryDeps(watch.fn);
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, new AbortController().signal, undefined, []);
		assert.equal(result.errorMessage, "WebSocket error");
		assert.equal(deps.respawns, 0);
		assert.equal(watch.calls.length, 1);
	});

	it("does not respawn when the signal is already aborted", async () => {
		const watch = queueingWatch([err("WebSocket error")]);
		const deps = retryDeps(watch.fn);
		const controller = new AbortController();
		controller.abort();
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, controller.signal, undefined, [5, 5]);
		assert.equal(result.errorMessage, "WebSocket error");
		assert.equal(deps.respawns, 0);
	});

	it("does not start a retry whose backoff alone would exceed the deadline", async () => {
		const watch = queueingWatch([err("WebSocket error")]);
		const deps = retryDeps(watch.fn);
		// 1s deadline, 5s backoff: the first retry can't fit, so no respawn.
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, new AbortController().signal, 1, [5000]);
		assert.equal(result.errorMessage, "WebSocket error");
		assert.equal(deps.respawns, 0);
		assert.equal(watch.calls.length, 1);
	});

	it("terminates the freshly spawned child and stops if the signal aborts during respawn", async () => {
		const watch = queueingWatch([err("WebSocket error"), ok()]);
		const controller = new AbortController();
		const deps: BackgroundRetryDeps = {
			watch: watch.fn,
			respawn: async () => {
				controller.abort();
			},
			terminate: () => {},
		};
		let terminates = 0;
		deps.terminate = () => terminates++;
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, controller.signal, undefined, [5]);
		assert.equal(result.errorMessage, "WebSocket error");
		assert.equal(terminates, 1);
		assert.equal(watch.calls.length, 1); // second watch never happened
	});

	it("backs off for the configured delay before respawning", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const watch = queueingWatch([err("WebSocket error"), ok("recovered")]);
			const deps = retryDeps(watch.fn);
			const promise = watchBackgroundSubagentWithRetry(bgRunning(), deps, new AbortController().signal, undefined, [5000]);
			await flushMicrotasks();
			// Still inside the 5s backoff window: no respawn yet.
			assert.equal(deps.respawns, 0);
			mock.timers.tick(5000);
			await flushMicrotasks();
			const result = await promise;
			assert.equal(result.summary, "recovered");
			assert.equal(deps.respawns, 1);
		} finally {
			mock.timers.reset();
		}
	});

	it("surfaces the original failure when respawn throws", async () => {
		const watch = queueingWatch([err("WebSocket error"), ok()]);
		const deps: BackgroundRetryDeps = {
			watch: watch.fn,
			respawn: async () => {
				throw new Error("session metadata corrupted");
			},
			terminate: () => {},
		};
		const result = await watchBackgroundSubagentWithRetry(bgRunning(), deps, new AbortController().signal, undefined, [5, 5]);
		assert.equal(result.errorMessage, "WebSocket error");
	});
});
