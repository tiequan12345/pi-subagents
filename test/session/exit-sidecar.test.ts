import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assert, createTestDir } from "../support/index.ts";
import {
	clearSubagentExitSidecar,
	getSubagentExitSidecarPath,
	type SubagentExitSignal,
	writeSubagentExitSignal,
} from "../../src/session/exit-sidecar.ts";
import { consumeSubagentExitSignal } from "../../src/mux/poll.ts";

describe("subagent exit sidecars", () => {
	it("stores exit sidecars next to the child session and consumes them once", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		writeFileSync(sessionFile, "");
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 7 }));

		assert.equal(exitFile, `${sessionFile}.exit`);
		assert.deepEqual(consumeSubagentExitSignal(sessionFile), {
			reason: "done",
			exitCode: 0,
			outputTokens: 7,
			signal: { type: "done", outputTokens: 7 },
		});
		assert.equal(existsSync(exitFile), false);
		assert.equal(consumeSubagentExitSignal(sessionFile), null);
	});

	it("preserves stopReason toolUse when consuming the sidecar", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		writeFileSync(sessionFile, "");
		writeFileSync(
			exitFile,
			JSON.stringify({
				type: "error",
				errorMessage:
					"Subagent recovery exhausted after 3 consecutive tool-use boundary endings.",
				stopReason: "toolUse",
			}),
		);

		const consumed = consumeSubagentExitSignal(sessionFile);
		assert.equal(consumed?.reason, "error");
		assert.equal(consumed?.exitCode, 1);
		assert.equal(consumed?.signal?.type, "error");
		assert.equal(consumed?.signal?.stopReason, "toolUse");
		assert.equal(
			consumed?.signal?.errorMessage,
			"Subagent recovery exhausted after 3 consecutive tool-use boundary endings.",
		);
	});

	it("supersedes an existing error signal atomically", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		const error: SubagentExitSignal = {
			type: "error",
			errorMessage: "transient failure",
			stopReason: "error",
		};
		const done: SubagentExitSignal = { type: "done", outputTokens: 8 };
		writeFileSync(exitFile, JSON.stringify(error));

		assert.equal(writeSubagentExitSignal(sessionFile, done, { supersede: true }), true);
		assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), done);
		assert.deepEqual(
			readdirSync(dir).filter((name) => name.endsWith(".tmp")),
			[],
		);
	});

	it("refuses to supersede done, ping, or compacted signals", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		const existingSignals: SubagentExitSignal[] = [
			{ type: "done", outputTokens: 1 },
			{ type: "ping", name: "child", message: "help" },
			{ type: "compacted", outputTokens: 2 },
		];
		for (const existing of existingSignals) {
			writeFileSync(exitFile, JSON.stringify(existing));
			assert.equal(
				writeSubagentExitSignal(sessionFile, { type: "done" }, { supersede: true }),
				false,
			);
			assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), existing);
		}
	});

	it("replaces an unreadable signal only when superseding", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		writeFileSync(exitFile, "{not-json");
		const done: SubagentExitSignal = { type: "done", outputTokens: 8 };

		assert.equal(writeSubagentExitSignal(sessionFile, done), false);
		assert.equal(writeSubagentExitSignal(sessionFile, done, { supersede: true }), true);
		assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), done);
	});

	it("keeps first-write-wins behavior by default", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		const error: SubagentExitSignal = {
			type: "error",
			errorMessage: "failure",
			stopReason: "error",
		};
		writeFileSync(exitFile, JSON.stringify(error));

		assert.equal(writeSubagentExitSignal(sessionFile, { type: "done" }), false);
		assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), error);
	});

	it("clears stale sidecars before reusing a session path", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "resumed-child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		writeFileSync(sessionFile, "");
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 99 }));

		clearSubagentExitSidecar(sessionFile);

		assert.equal(existsSync(exitFile), false);
		assert.equal(consumeSubagentExitSignal(sessionFile), null);
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 3 }));
		assert.equal(readFileSync(exitFile, "utf8"), JSON.stringify({ type: "done", outputTokens: 3 }));
	});

	it("publishes atomically, keeps the first signal, and removes its temp file", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "atomic-child.jsonl");
		writeFileSync(sessionFile, "");

		assert.equal(
			writeSubagentExitSignal(sessionFile, { type: "compacted", outputTokens: 8 }),
			true,
		);
		assert.equal(
			writeSubagentExitSignal(sessionFile, { type: "done", outputTokens: 99 }),
			false,
		);
		assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
			type: "compacted",
			outputTokens: 8,
		});
		assert.deepEqual(
			readdirSync(dir).filter((name) => name.endsWith(".tmp")),
			[],
		);
	});
});
