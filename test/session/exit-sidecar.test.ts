import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assert, createTestDir } from "../support/index.ts";
import {
	clearSubagentExitSidecar,
	getSubagentExitSidecarPath,
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
