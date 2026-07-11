import { default as assert } from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { clearMuxBackendCache } from "../../src/mux/core.ts";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";

import {
	enforceAgentFrontmatterForTest,
	loadAgentDefaults,
	readSubagentLaunchMetadataForTest,
} from "../support/index.ts";


function createTestDir(): string {
	return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSessionFile(dir: string, entries: object[]): string {
	const file = join(dir, "test-session.jsonl");
	const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
	writeFileSync(file, content);
	return file;
}

function writeExecutable(dir: string, name: string, content: string): string {
	const file = join(dir, name);
	writeFileSync(file, content);
	chmodSync(file, 0o755);
	return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
	type: "message",
	id: "user-001",
	parentId: "mc-001",
	message: {
		role: "user",
		content: [{ type: "text", text: "Hello, sketch something" }],
	},
};
const ASSISTANT_MSG = {
	type: "message",
	id: "asst-001",
	parentId: "user-001",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Here is my outline..." }],
	},
};

function clearMuxRuntimeEnv(): void {
	delete process.env.CMUX_SOCKET_PATH;
	delete process.env.CMUX_SURFACE_ID;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	delete process.env.WEZTERM_PANE;
	delete process.env.WEZTERM_UNIX_SOCKET;
	delete process.env.ZELLIJ;
	delete process.env.ZELLIJ_SESSION_NAME;
	delete process.env.HERDR_PANE_ID;
	delete process.env.HERDR_TAB_ID;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.PI_SUBAGENT_MUX;
	delete process.env.PI_SUBAGENT_PI_COMMAND;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_SESSION;
	delete process.env.PI_SUBAGENT_SURFACE;
	delete process.env.PI_SUBAGENT_RENAME_ORCA_WORKTREE;
	delete process.env.FAKE_ORCA_LOG;
	delete process.env.FAKE_ORCA_MODE;
	delete process.env.FAKE_ORCA_SCREEN;
}

function writeFakeOrca(dir: string): string {
	const logFile = join(dir, "orca.log");
	writeFileSync(logFile, "");
	writeExecutable(
		dir,
		"orca",
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> "${logFile}"`,
			"",
			`if [ "$*" = "status --json" ]; then`,
			'  printf \'%s\\n\' \'{"ok":true,"result":{"app":{"running":true},"runtime":{"reachable":true,"state":"ready"}}}\'',
			"  exit 0",
			"fi",
			"",
			`if [ "$*" = "worktree current --json" ]; then`,
			'  printf \'%s\\n\' \'{"ok":true,"result":{"worktree":{"id":"wt_active","display_name":"Main","path":"/parent"}}}\'',
			"  exit 0",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "create" ]; then',
			'  printf \'%s\\n\' \'{"ok":true,"result":{"terminal":{"handle":"term_child","id":"term_new"}}}\'',
			"  exit 0",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "send" ]; then',
			"  exit 0",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "rename" ]; then',
			'  printf \'%s\\n\' \'{"ok":true,"result":{"terminal":"renamed"}}\'',
			"  exit 0",
			"fi",
			"",
			'printf \'%s\\n\' \'{"error":{"code":"unknown_command","message":"unsupported fake orca command"}}\'',
			"exit 1",
		].join("\n"),
	);
	return logFile;
}

function useFakeOrca(): { dir: string; logFile: string } {
	const dir = createTestDir();
	const logFile = writeFakeOrca(dir);
	clearMuxRuntimeEnv();
	process.env.PATH = dir;
	if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
	return { dir, logFile };
}

function writeParentSession(dir: string): string {
	return createSessionFile(dir, [
		SESSION_HEADER,
		MODEL_CHANGE,
		USER_MSG,
		ASSISTANT_MSG,
	]);
}

async function readEventually(
	path: string,
	isReady: (text: string) => boolean = (text) => text.trim().length > 0,
): Promise<string> {
	let lastText = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		if (existsSync(path)) {
			lastText = readFileSync(path, "utf8");
			if (isReady(lastText)) return lastText;
		}
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${path}; last content: ${lastText}`);
}

function extractTaskArtifactPath(commandText: string): string {
	const match = commandText.match(/'@([^']+)'/);
	if (!match?.[1]) throw new Error("Expected Orca launch command to include a task artifact argument");
	return match[1];
}

function readOrcaRunScript(log: string): string {
	const match = log.match(/terminal send --terminal term_child --text '([^;]+)'; rm -f '\1' --enter --json/);
	if (!match?.[1]) throw new Error("Expected Orca launch command to send a staged shell script");
	return readFileSync(match[1], "utf8");
}

describe("Orca interactive launch parity", () => {
	it("launches interactive Orca children with resolved cwd, session, env, and surface+mux facts", async () => {
		const { logFile } = useFakeOrca();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		const childCwd = join(cwd, "child-workspace");
		mkdirSync(childCwd, { recursive: true });
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "orca-path-session.md"),
			[
				"---",
				"name: orca-path-session",
				"session-mode: fork",
				"no-session: true",
				"trust-project: true",
				"cwd: child-workspace",
				"env: |",
				"  CUSTOM_ENV=from-agent",
				"flags: --alpha 'two words'",
				"---",
				"Preserve resolved runtime facts through Orca.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const waitedSurfaces: string[] = [];

		const running = await launchInteractiveSubagent(
			{
				name: "orca-path-session-child",
				title: "Orca path session child",
				task: "Check Orca launch parity.",
				agent: "orca-path-session",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: () => 4096,
				getShellReadyDelayMs: () => 0,
				waitForInteractivePrompt: async (surface) => {
					waitedSurfaces.push(surface);
				},
			},
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "term_child");
		assert.equal(running.noSession, true);
		assert.equal(running.modelContextWindow, 4096);
		assert.deepEqual(waitedSurfaces, ["term_child"]);

		const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
		assert.equal(metadata?.mode, "interactive");
		assert.equal(metadata?.sessionMode, "fork");
		assert.equal(metadata?.noSession, true);
		assert.equal(metadata?.trustProject, true);
		assert.equal(metadata?.cwd, childCwd);
		assert.equal(metadata?.env, "CUSTOM_ENV=from-agent");
		assert.equal(metadata?.flags, "--alpha 'two words'");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /status --json/);
		assert.match(log, /worktree current --json/);
		assert.match(log, /terminal create --worktree active --title \[orca-path-session\] Orca path session child --json/);
		assert.match(log, /terminal send --terminal term_child --text /);

		const launchScript = readOrcaRunScript(log);
		assert.match(launchScript, new RegExp(`cd '${childCwd.replace(/'/g, "'\\''")}' &&`));
		assert.match(launchScript, new RegExp(`'--session' '${running.sessionFile.replace(/'/g, "'\\''")}'`));
		assert.match(launchScript, /'--no-session'/);
		assert.match(launchScript, /'--approve'/);
		assert.match(launchScript, /CUSTOM_ENV='from-agent'/);
		assert.match(launchScript, /PI_SUBAGENT_SURFACE='term_child'/);
		assert.match(launchScript, /PI_SUBAGENT_MUX='orca'/);
		assert.match(launchScript, /'--alpha' 'two words'/);
	});

	it("honors an explicit Orca mux preference at the launch seam", async () => {
		const { logFile } = useFakeOrca();
		process.env.PI_SUBAGENT_MUX = "orca";
		if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "forced-orca.md"),
			[
				"---",
				"name: forced-orca",
				"mode: interactive",
				"auto-exit: true",
				"async: false",
				"spawning: false",
				"---",
				"Launch through explicitly forced Orca.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const baseParams = {
			name: "forced-orca-child",
			title: "Forced Orca child",
			task: "Check forced Orca launch parity.",
			agent: "forced-orca",
		};
		const agentDefs = loadAgentDefaults("forced-orca", undefined, cwd);
		const effectiveParams = enforceAgentFrontmatterForTest(baseParams, agentDefs);
		assert.equal(effectiveParams.async, false);
		assert.equal(effectiveParams.blocking, true);

		const running = await launchInteractiveSubagent(
			effectiveParams,
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: () => 4096,
				getShellReadyDelayMs: () => 0,
				waitForInteractivePrompt: async () => {},
			},
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "term_child");
		assert.equal(running.async, false);
		assert.equal(running.blocking, true);
		assert.equal(running.autoExit, true);

		const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
		assert.equal(metadata?.mode, "interactive");
		assert.equal(metadata?.autoExit, true);
		assert.equal(metadata?.async, false);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /status --json/);
		assert.match(log, /terminal create --worktree active --title \[forced-orca\] Forced orca child --json/);
		assert.match(log, /terminal send --terminal term_child --text /);
		const launchScript = readOrcaRunScript(log);
		assert.match(launchScript, /PI_SUBAGENT_SURFACE='term_child'/);
		assert.match(launchScript, /PI_SUBAGENT_MUX='orca'/);
	});
});
