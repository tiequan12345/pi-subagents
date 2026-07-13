import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { watchBackgroundSubagentWithRetry } from "../../src/runtime/background-retry.ts";
import { writeSubagentExitSignal } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir, describe, it } from "../support/index.ts";

describe("watchBackgroundSubagent threshold compaction", () => {
	it("does not reap a stable auto-exit child while compaction exceeds the old grace period", async () => {
		const sessionFile = join(createTestDir(), "child.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "stable summary" }],
				},
			})}\n`,
		);
		const child = new EventEmitter() as ChildProcess;
		Object.assign(child, { pid: undefined, killed: false });
		const running = {
			id: "bg-1",
			name: "worker",
			task: "compact",
			mode: "background",
			executionState: "running",
			deliveryState: "awaited",
			parentClosePolicy: "terminate",
			autoExit: true,
			childProcess: child,
			startTime: Date.now(),
			sessionFile,
		} satisfies RunningSubagent;
		const resultPromise = watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile() {} },
			new AbortController().signal,
		);

		await new Promise((resolve) => setTimeout(resolve, 3_100));
		writeSubagentExitSignal(sessionFile, { type: "compacted" });
		child.emit("exit", 0);
		const result = await resultPromise;
		assert.equal(result.exitSignal?.type, "compacted");
	});

	it("observes cross-process compacted publication, resumes the same session, and completes", async () => {
		const sessionFile = join(createTestDir(), "cross-process.jsonl");
		writeFileSync(sessionFile, "");
		const fixture = join(
			process.cwd(),
			"test/runtime/fixtures/threshold-child.ts",
		);
		const launch = (phase: "compact" | "complete") =>
			spawn(
				process.execPath,
				[...process.execArgv, fixture, sessionFile, phase],
				{ stdio: "ignore" },
			);
		const running = {
			id: "bg-process",
			name: "worker",
			task: "compact then complete",
			mode: "background",
			executionState: "running",
			deliveryState: "awaited",
			parentClosePolicy: "terminate",
			autoExit: true,
			childProcess: launch("compact"),
			startTime: Date.now(),
			sessionFile,
		} satisfies RunningSubagent;
		const runtime = { cleanupNoSessionSessionFile() {} };

		const result = await watchBackgroundSubagentWithRetry(
			running,
			{
				watch: (current, signal, timeout) =>
					watchBackgroundSubagent(current, runtime, signal, timeout),
				async respawn(current) {
					current.childProcess = launch("complete");
					current.startTime = Date.now();
				},
				terminate(current) {
					current.childProcess?.kill("SIGTERM");
				},
			},
			new AbortController().signal,
			10,
			[],
			1,
		);

		assert.equal(result.exitSignal?.type, "done");
		assert.equal(result.outputTokens, 23);
		assert.equal(result.summary, "RESUMED_COMPLETE");
	});
});
