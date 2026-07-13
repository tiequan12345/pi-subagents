import {
	assert,
	readFileSync,
	rmSync,
	writeFileSync,
	join,
	describe,
	it,
	subagentDoneExtension,
	createTestDir,
} from "../support/index.ts";

/**
 * Child-side harness for the background autoExit lifecycle around threshold
 * compaction. Drives the REAL subagent-done extension without a `pi -p` process:
 * the child only needs to detect threshold compaction and signal it on
 * shutdown; the parent (background-retry) does the actual resume.
 */
function loadChild(options: { interactive?: boolean } = {}) {
	const handlers = new Map<string, (...args: any[]) => void>();
	const dir = createTestDir();
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(sessionFile, "");

	process.env.PI_SUBAGENT_SESSION = sessionFile;
	process.env.PI_SUBAGENT_AUTO_EXIT = "1";
	if (options.interactive) process.env.PI_SUBAGENT_SURFACE = "fake-pane";
	else delete process.env.PI_SUBAGENT_SURFACE;

	subagentDoneExtension({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools() {},
		registerTool(definition: { name: string }) {
			return definition;
		},
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		sendUserMessage() {
			// Background `pi -p` children must NOT self-revive via sendUserMessage
			// (it starts a reentrant prompt that races print-mode disposal). Assert
			// the child never tries: the parent resumes instead.
			throw new Error("child must not sendUserMessage after compaction");
		},
		registerShortcut() {},
	} as any);

	return {
		handlers,
		sessionFile,
		dir,
		cleanup() {
			delete process.env.PI_SUBAGENT_SESSION;
			delete process.env.PI_SUBAGENT_AUTO_EXIT;
			delete process.env.PI_SUBAGENT_SURFACE;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function readExit(sessionFile: string) {
	return JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
}
function assertNoExit(sessionFile: string) {
	assert.throws(() => readFileSync(`${sessionFile}.exit`, "utf8"));
}

describe("threshold-compaction signaling (child)", () => {
	it("writes a compacted sidecar after a threshold compaction (background)", () => {
		const h = loadChild();
		try {
			h.handlers.get("session_before_compact")?.({ reason: "threshold", signal: new AbortController().signal });
			h.handlers.get("session_compact")?.({ reason: "threshold", willRetry: false });
			// Background clean agent_end defers the sidecar to shutdown; nothing yet.
			assertNoExit(h.sessionFile);
			h.handlers.get("session_shutdown")?.();
			assert.deepEqual(readExit(h.sessionFile), { type: "compacted", outputTokens: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("surfaces an error when threshold compaction is attempted but never completes", () => {
		const h = loadChild();
		try {
			// session_before_compact fired (compaction started) but session_compact
			// never followed: compaction failed or was aborted.
			h.handlers.get("session_before_compact")?.({ reason: "threshold", signal: new AbortController().signal });
			h.handlers.get("session_shutdown")?.();
			const exit = readExit(h.sessionFile);
			assert.equal(exit.type, "error");
			assert.match(exit.errorMessage ?? "", /Threshold compaction failed/);
		} finally {
			h.cleanup();
		}
	});

	it("resets completed or interrupted compaction when another agent run starts", () => {
		for (const completed of [false, true]) {
			const h = loadChild();
			try {
				h.handlers.get("session_before_compact")?.({
					reason: "threshold",
					signal: new AbortController().signal,
				});
				if (completed) {
					h.handlers.get("session_compact")?.({
						reason: "threshold",
						willRetry: false,
					});
				}
				h.handlers.get("agent_start")?.();
				h.handlers.get("session_shutdown")?.();
				assert.deepEqual(readExit(h.sessionFile), {
					type: "done",
					outputTokens: 0,
				});
			} finally {
				h.cleanup();
			}
		}
	});

	it("does not signal compaction for overflow (Pi auto-retries natively)", () => {
		const h = loadChild();
		try {
			h.handlers.get("session_compact")?.({ reason: "overflow", willRetry: true });
			h.handlers.get("session_shutdown")?.();
			assert.deepEqual(readExit(h.sessionFile), { type: "done", outputTokens: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("writes done when no compaction occurred", () => {
		const h = loadChild();
		try {
			h.handlers.get("session_shutdown")?.();
			assert.deepEqual(readExit(h.sessionFile), { type: "done", outputTokens: 0 });
		} finally {
			h.cleanup();
		}
	});

	it("does not flag compaction for interactive panes (operator can continue)", () => {
		const h = loadChild({ interactive: true });
		try {
			h.handlers.get("session_compact")?.({ reason: "threshold", willRetry: false });
			h.handlers.get("agent_end")?.(
				{
					messages: [
						{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
					],
				},
				{ isIdle: () => true, ui: { setStatus() {} }, shutdown() {} },
			);
			// Interactive autoExit still exits "done" at agent_end (known gap: it does
			// not yet defer for compaction). The compaction flag is never set.
			assert.deepEqual(readExit(h.sessionFile), { type: "done", outputTokens: 0 });
		} finally {
			h.cleanup();
		}
	});
});
