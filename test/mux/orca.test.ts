import { default as assert } from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Import mux functions directly from source modules to avoid the broken barrel (src/mux.ts
// tries to re-export isOrcaAvailable from core.ts which doesn't export it yet).
import {
	getMuxBackend,
	isMuxAvailable,
	muxSetupHint,
} from "../../src/mux/core.ts";
import {
	clearMuxBackendCache,
} from "../../src/mux/core.ts";
import {
	createSurface,
	createSurfaceSplit,
	renameCurrentTab,
	renameWorkspace,
} from "../../src/mux/surfaces.ts";
import {
	closeSurface,
	readScreen,
	readScreenAsync,
	sendCommand,
	sendShellCommand,
} from "../../src/mux/io.ts";
import {
	isOrcaAvailable,
} from "../../src/mux/orca.ts";

function createTestDir(): string {
	return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

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
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_SESSION;
	delete process.env.PI_SUBAGENT_SURFACE;
	delete process.env.PI_SUBAGENT_RENAME_ORCA_WORKTREE;
	delete process.env.FAKE_ORCA_LOG;
	delete process.env.FAKE_ORCA_MODE;
	delete process.env.FAKE_ORCA_SCREEN;
}

function writeExecutable(dir: string, name: string, content: string): string {
	const file = join(dir, name);
	writeFileSync(file, content);
	chmodSync(file, 0o755);
	return file;
}

function writeFakeOrca(dir: string): string {
	const logFile = join(dir, "orca.log");
	writeFileSync(logFile, "");
	writeExecutable(
		dir,
		"orca",
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> "$FAKE_ORCA_LOG"`,
			'mode="${FAKE_ORCA_MODE:-available}"',
			"",
			`if [ "$*" = "status --json" ]; then`,
			'  case "$mode" in',
			"    stopped)",
			'      printf \'%s\\n\' \'{"ok":true,"result":{"app":{"running":false},"runtime":{"reachable":false,"state":"stopped"}}}\'',
			"      ;;",
			"    not-in-worktree)",
			'      printf \'%s\\n\' \'{"ok":true,"result":{"app":{"running":true},"runtime":{"reachable":true,"state":"ready"}}}\'',
			"      exit 1",
			"      ;;",
			"    malformed-status)",
			"      printf '%s\\n' 'not-json'",
			"      ;;",
			"    wrong-envelope)",
			'      printf \'%s\\n\' \'{"ok":true,"data":{"runtime":{"running":true}}}\'',
			"      ;;",
			"    *)",
			'      printf \'%s\\n\' \'{"ok":true,"result":{"app":{"running":true},"runtime":{"reachable":true,"state":"ready"}}}\'',
			"      ;;",
			"  esac",
			"  exit 0",
			"fi",
			"",
			`if [ "$*" = "worktree current --json" ]; then`,
			'  case "$mode" in',
			"    not-in-worktree)",
			'      printf \'%s\\n\' \'{"error":{"code":"not_in_worktree","message":"not in a worktree"}}\'',
			"      exit 1",
			"      ;;",
			"    worktree-api-error)",
			'      printf \'%s\\n\' \'{"error":{"code":"orca_api_error","message":"worktree lookup failed"}}\'',
			"      exit 1",
			"      ;;",
			"    *)",
			'      printf \'%s\\n\' \'{"ok":true,"result":{"worktree":{"id":"wt_active","display_name":"Main","path":"/workspace"}}}\'',
			"      exit 0",
			"      ;;",
			"  esac",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "create" ]; then',
			'  case "$mode" in',
			"    create-no-handle)",
			'      printf \'%s\\n\' \'{"ok":true,"result":{"terminal":{"id":"term_new"}}}\'',
			"      exit 0",
			"      ;;",
			"    create-api-error)",
			'      printf \'%s\\n\' \'{"error":{"code":"terminal_create_failed","message":"create refused"}}\'',
			"      exit 1",
			"      ;;",
			"    *)",
			'      printf \'%s\\n\' \'{"ok":true,"result":{"terminal":{"handle":"term_child","id":"term_new"}}}\'',
			"      exit 0",
			"      ;;",
			"  esac",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "split" ]; then',
			'  direction=""',
			'  previous=""',
			'  for arg in "$@"; do',
			'    if [ "$previous" = "--direction" ]; then direction="$arg"; fi',
			'    previous="$arg"',
			'  done',
			'printf \'{"ok":true,"result":{"terminal":{"handle":"term_split_%s","id":"term_split_new"}}}\n\' "$direction"',
			"  exit 0",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "send" ]; then',
			'  case "$mode" in',
			"    send-api-error)",
			'      printf \'%s\\n\' \'{"error":{"code":"send_failed","message":"send refused"}}\'',
			"      exit 1",
			"      ;;",
			"    *)",
			"      exit 0",
			"      ;;",
			"  esac",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "read" ]; then',
			'  handle=""',
			'  previous=""',
			'  for arg in "$@"; do',
			'    if [ "$previous" = "--terminal" ]; then handle="$arg"; fi',
			'    previous="$arg"',
			'  done',
			'  case "$handle" in',
			"    stale_handle)",
			'      printf \'%s\\n\' \'{"error":{"code":"terminal_handle_stale","message":"handle is stale"}}\'',
			"      exit 1",
			"      ;;",
			"    not_found_handle)",
			'      printf \'%s\\n\' \'{"error":{"code":"terminal_not_found","message":"terminal not found"}}\'',
			"      exit 1",
			"      ;;",
			"    transient_handle)",
			'      printf \'%s\\n\' \'{"error":{"code":"timeout","message":"request timed out"}}\'',
			"      exit 1",
			"      ;;",
			"    generic_rpc_handle)",
			'      printf \'%s\\n\' \'{"error":{"code":"internal_error","message":"RPC failed"}}\'',
			"      exit 1",
			"      ;;",
			"    *)",
			'      if [ -f "$FAKE_ORCA_SCREEN" ]; then',
			'        lines=""',
			'        while IFS= read -r line; do',
			'          if [ -z "$lines" ]; then',
			'            lines="\\"$line\\""',
			"          else",
			'            lines="$lines,\\"$line\\""',
			"          fi",
			"        done < \"$FAKE_ORCA_SCREEN\"",
			"        printf '%s\\n' '{\"ok\":true,\"result\":{\"terminal\":{\"tail\":['\"$lines\"']}}}'",
			"      else",
			"        printf '%s\\n' '{\"ok\":true,\"result\":{\"terminal\":{\"tail\":[]}}}'",
			"      fi",
			"      exit 0",
			"      ;;",
			"  esac",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "close" ]; then',
			'  handle=""',
			'  previous=""',
			'  for arg in "$@"; do',
			'    if [ "$previous" = "--terminal" ]; then handle="$arg"; fi',
			'    previous="$arg"',
			'  done',
			'  case "$handle" in',
			"    stale_handle)",
			'      printf \'%s\\n\' \'{"error":{"code":"terminal_handle_stale","message":"handle is stale"}}\'',
			"      exit 1",
			"      ;;",
			"    not_found_handle)",
			'      printf \'%s\\n\' \'{"error":{"code":"terminal_not_found","message":"terminal not found"}}\'',
			"      exit 1",
			"      ;;",
			"    close_refused)",
			'      printf \'%s\\n\' \'{"error":{"code":"permission_denied","message":"close refused"}}\'',
			"      exit 1",
			"      ;;",
			"    *)",
			'      printf \'%s\\n\' \'{"ok":true,"result":{"terminal":"closed"}}\'',
			"      exit 0",
			"      ;;",
			"  esac",
			"fi",
			"",
			'if [ "$1" = "terminal" ] && [ "$2" = "rename" ]; then',
			'  printf \'%s\\n\' \'{"ok":true,"result":{"terminal":"renamed"}}\'',
			"  exit 0",
			"fi",
			"",
			'if [ "$1" = "worktree" ] && [ "$2" = "set" ]; then',
			'  printf \'%s\\n\' \'{"ok":true,"result":{"worktree":{"display_name":"set"}}}\'',
			"  exit 0",
			"fi",
			"",
			'printf \'%s\\n\' \'{"error":{"code":"unknown_command","message":"unsupported fake orca command"}}\'',
			"exit 1",
		].join("\n"),
	);
	return logFile;
}

function useFakeOrca(mode = "available"): {
	dir: string;
	logFile: string;
	screenFile: string;
} {
	const dir = createTestDir();
	const logFile = writeFakeOrca(dir);
	const screenFile = join(dir, "orca-screen.txt");
	writeFileSync(screenFile, "orca line 1\norca line 2\n");
	clearMuxRuntimeEnv();
	process.env.PATH = dir;
	process.env.FAKE_ORCA_LOG = logFile;
	process.env.FAKE_ORCA_MODE = mode;
	process.env.FAKE_ORCA_SCREEN = screenFile;
	if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
	return { dir, logFile, screenFile };
}

function writeFakeCommand(dir: string, command: string): void {
	writeExecutable(dir, command, "#!/bin/sh\nexit 0\n");
}

describe("Orca mux backend", () => {
	describe("backend selection", () => {
		it("selects Orca when orca is on PATH, status reports ready, and worktree resolves", () => {
			useFakeOrca();

			assert.equal(isOrcaAvailable(), true);
			assert.equal(isMuxAvailable(), true);
			assert.equal(getMuxBackend(), "orca");
		});

		it("does not select Orca when the orca command is missing", () => {
			const dir = createTestDir();
			clearMuxRuntimeEnv();
			process.env.PATH = dir;
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			assert.equal(isOrcaAvailable(), false);
			assert.equal(getMuxBackend(), null);
		});

		it("does not select Orca when status reports not running", () => {
			useFakeOrca("stopped");

			assert.equal(isOrcaAvailable(), false);
			assert.equal(getMuxBackend(), null);
		});

		it("does not select Orca when orca exits nonzero on worktree current", () => {
			useFakeOrca("not-in-worktree");

			assert.equal(isOrcaAvailable(), false);
			assert.equal(getMuxBackend(), null);
		});

		it("does not select Orca when status JSON is not the expected envelope shape", () => {
			useFakeOrca("wrong-envelope");

			assert.equal(isOrcaAvailable(), false);
		});

		it("does not select Orca when status JSON is malformed", () => {
			useFakeOrca("malformed-status");

			assert.equal(isOrcaAvailable(), false);
		});

		it("prefers Orca over an outer tmux when both are available", () => {
			const { dir } = useFakeOrca();
			writeFakeCommand(dir, "tmux");
			process.env.TMUX = "fake-tmux-socket";
			process.env.TMUX_PANE = "%1";

			assert.equal(getMuxBackend(), "orca");
		});

		it("uses forced Orca only when Orca is actually available", () => {
			useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
			assert.equal(getMuxBackend(), "orca");

			useFakeOrca("not-in-worktree");
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
			assert.equal(getMuxBackend(), null);
		});

		for (const { backend, command, envKey, envValue } of [
			{
				backend: "tmux",
				command: "tmux",
				envKey: "TMUX",
				envValue: "fake-tmux-socket",
			},
			{
				backend: "cmux",
				command: "cmux",
				envKey: "CMUX_SOCKET_PATH",
				envValue: "/tmp/fake-cmux.sock",
			},
			{
				backend: "zellij",
				command: "zellij",
				envKey: "ZELLIJ_SESSION_NAME",
				envValue: "fake-zellij",
			},
			{
				backend: "wezterm",
				command: "wezterm",
				envKey: "WEZTERM_UNIX_SOCKET",
				envValue: "fake-wezterm-socket",
			},
		] as const) {
			it(`respects forced ${backend} preference over available Orca`, () => {
				const { dir } = useFakeOrca();
				writeFakeCommand(dir, command);
				process.env.PI_SUBAGENT_MUX = backend;
				process.env[envKey] = envValue;
				if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

				assert.equal(getMuxBackend(), backend);
			});
		}

		it("resolves Orca via auto-detection before cmux when no override is set", () => {
			const { dir } = useFakeOrca();
			writeFakeCommand(dir, "cmux");
			delete process.env.PI_SUBAGENT_MUX;
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			// Orca is auto-detected; cmux is also available but orca wins order
			assert.equal(getMuxBackend(), "orca");
		});

		it("returns an Orca-specific setup hint", () => {
			process.env.PI_SUBAGENT_MUX = "orca";

			assert.match(muxSetupHint(), /Orca/);
		});
	});

	describe("surface creation", () => {
		it("creates normal surfaces via orca terminal create and returns the handle", () => {
			const { logFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			assert.equal(createSurface("Orca Child"), "term_child");

			const log = readFileSync(logFile, "utf8");
			assert.match(
				log,
				/terminal create --worktree active --title Orca Child --json/,
			);
		});

		it("creates explicit right Orca splits via terminal split horizontal", () => {
			const { logFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			const handle = createSurfaceSplit("Orca Split Right", "right", "term_parent");
			assert.equal(handle, "term_split_horizontal");

			const log = readFileSync(logFile, "utf8");
			assert.match(
				log,
				/terminal split --terminal term_parent --direction horizontal --json/,
			);
		});

		it("creates explicit down Orca splits via terminal split vertical", () => {
			const { logFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			const handle = createSurfaceSplit("Orca Split Down", "down", "term_parent");
			assert.equal(handle, "term_split_vertical");

			const log = readFileSync(logFile, "utf8");
			assert.match(
				log,
				/terminal split --terminal term_parent --direction vertical --json/,
			);
		});

		for (const direction of ["left", "up"] as const) {
			it(`rejects unsupported ${direction} Orca splits`, () => {
				const { logFile } = useFakeOrca();
				process.env.PI_SUBAGENT_MUX = "orca";
				if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

				assert.throws(
					() => createSurfaceSplit("Orca Split", direction, "term_parent"),
					/Orca split direction.*unsupported/,
				);

				const log = readFileSync(logFile, "utf8");
				assert.doesNotMatch(log, /terminal split/);
			});
		}

		it("rejects createSurfaceSplit without fromSurface", () => {
			useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			assert.throws(
				() => createSurfaceSplit("No Origin", "right", undefined),
				/createOrcaSplit requires fromSurface/,
			);
		});
	});

	describe("I/O, titles, and cleanup", () => {
		it("sends commands, empty Enter, shell commands, reads recent output, and closes surfaces", async () => {
			const { logFile, screenFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
			writeFileSync(
				screenFile,
				"orca line 1\norca line 2\n__SUBAGENT_DONE_0__\n",
			);

			sendCommand("term_child", "echo orca");
			sendCommand("term_child", "");
			sendShellCommand("term_child", "printf shell");

			assert.match(readScreen("term_child", 10), /__SUBAGENT_DONE_0__/);
			assert.match(await readScreenAsync("term_child", 10), /orca line 2/);
			closeSurface("term_child");

			const log = readFileSync(logFile, "utf8");
			// sendCommand: correct argv with --terminal, --text, --enter
			assert.match(
				log,
				/terminal send --terminal term_child --text echo orca --enter --json/,
			);
			// Empty command: bare --enter
			assert.match(
				log,
				/terminal send --terminal term_child --text  --enter --json/,
			);

			// sendShellCommand: staged temp script, sent as <path>; rm -f <path>
			const stagedPath = log.match(
				/terminal send --terminal term_child --text '([^;]+)'; rm -f '\1' --enter --json/,
			)?.[1];
			assert.ok(stagedPath, "expected sendShellCommand to stage an Orca shell command");
			assert.match(readFileSync(stagedPath, "utf8"), /printf shell/);

			// readScreen/readScreenAsync: parsed result.terminal.tail
			assert.match(log, /terminal read --terminal term_child --json/);

			// closeSurface
			assert.match(log, /terminal close --terminal term_child --json/);
		});

		it("sends commands with trailing newline without double-enter", () => {
			const { logFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			sendCommand("term_child", "echo hello\n");

			const log = readFileSync(logFile, "utf8");
			// --enter appears exactly once in the log (one send, one enter)
			const enterCount = (log.match(/--enter --json/g) ?? []).length;
			assert.equal(enterCount, 1);
		});

		it("reports Orca send failures", () => {
			const { logFile } = useFakeOrca("send-api-error");
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			assert.throws(
				() => sendCommand("term_child", "echo boom"),
				/Orca.*send.*failed/,
			);

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /terminal send --terminal term_child --text echo boom --enter --json/);
		});

		it("renames Orca tab from PI_SUBAGENT_SURFACE and workspace behind opt-in", () => {
			const { logFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			process.env.PI_SUBAGENT_SURFACE = "term_child";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			renameCurrentTab("Env Tab");

			let log = readFileSync(logFile, "utf8");
			assert.match(log, /terminal rename --terminal term_child --title Env Tab --json/);

			// renameWorkspace is gated: without the opt-in, it does not call worktree set
			writeFileSync(logFile, "");
			renameWorkspace("Should Be Ignored");
			log = readFileSync(logFile, "utf8");
			// With PI_SUBAGENT_MUX=orca, every getMuxBackend() call re-runs detection
			// (cache is bypassed for explicit override), so status calls are expected.
			// Only check that worktree set was NOT called.
			assert.doesNotMatch(log, /worktree set/);

			// With the opt-in, renameWorkspace calls worktree set
			process.env.PI_SUBAGENT_RENAME_ORCA_WORKTREE = "1";
			renameWorkspace("New Workspace");
			log = readFileSync(logFile, "utf8");
			assert.match(log, /worktree set --worktree active --display-name New Workspace --json/);
		});

		it("ignores already-closed or stale Orca surfaces but propagates real failures", () => {
			const { logFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();

			// stale handle — swallowed
			assert.doesNotThrow(() => closeSurface("stale_handle"));
			// not found — swallowed
			assert.doesNotThrow(() => closeSurface("not_found_handle"));
			// real close refusal — propagated
			assert.throws(
				() => closeSurface("close_refused"),
				/Orca.*close.*failed/,
			);

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /terminal close --terminal stale_handle --json/);
			assert.match(log, /terminal close --terminal not_found_handle --json/);
			assert.match(log, /terminal close --terminal close_refused --json/);
		});
	});

	describe("readScreen stale vs transient classification", () => {
		function setupOrcaWithMux(): void {
			useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
		}

		it("throws on stale handle (sync)", () => {
			setupOrcaWithMux();

			assert.throws(
				() => readScreen("stale_handle", 10),
				/Orca terminal read failed: terminal_handle_stale/,
			);
		});

		it("throws on stale handle (async)", async () => {
			setupOrcaWithMux();

			await assert.rejects(
				() => readScreenAsync("stale_handle", 10),
				/Orca terminal read failed: terminal_handle_stale/,
			);
		});

		it("returns empty string on transient timeout (sync)", () => {
			setupOrcaWithMux();

			assert.equal(readScreen("transient_handle", 10), "");
		});

		it("returns empty string on transient timeout (async)", async () => {
			setupOrcaWithMux();

			assert.equal(await readScreenAsync("transient_handle", 10), "");
		});

		it("returns empty string on generic RPC error (sync)", () => {
			setupOrcaWithMux();

			assert.equal(readScreen("generic_rpc_handle", 10), "");
		});

		it("returns empty string on generic RPC error (async)", async () => {
			setupOrcaWithMux();

			assert.equal(await readScreenAsync("generic_rpc_handle", 10), "");
		});
	});

	describe("readScreen tail behavior", () => {
		it("returns all lines when tail count exceeds available lines", () => {
			const { screenFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
			writeFileSync(screenFile, "line1\nline2\nline3\n");

			const text = readScreen("term_child", 100);
			assert.equal(text, "line1\nline2\nline3");
		});

		it("returns last N lines when tail count is smaller", () => {
			const { screenFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
			writeFileSync(screenFile, "line1\nline2\nline3\nline4\nline5\n");

			const text = readScreen("term_child", 2);
			assert.equal(text, "line4\nline5");
		});

		it("returns empty string from empty screen (async)", async () => {
			const { screenFile } = useFakeOrca();
			process.env.PI_SUBAGENT_MUX = "orca";
			if (typeof clearMuxBackendCache === "function") clearMuxBackendCache();
			writeFileSync(screenFile, "");

			assert.equal(await readScreenAsync("term_child", 10), "");
		});
	});
});
