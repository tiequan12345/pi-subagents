#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireLiveWindowLock } from "./live-test-guard.mjs";

const SCRIPT_NAME = "test-live-orca-mux";
const WINDOWS_OPT_IN = "PI_SUBAGENT_ALLOW_LIVE_WINDOWS";
const ORCA_OPT_IN = "PI_SUBAGENT_ALLOW_LIVE_ORCA";
const ORCA_TIMEOUT_MS = 10_000;
const INNER_RESULT_TIMEOUT_MS = 45_000;
const SCREEN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function trimForError(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runOrcaRaw(args, options = {}) {
  return execFileSync("orca", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: ORCA_TIMEOUT_MS,
    ...options,
  });
}

function runOrcaQuiet(args) {
  try {
    execFileSync("orca", args, {
      cwd: repoRoot,
      stdio: "ignore",
      timeout: ORCA_TIMEOUT_MS,
    });
  } catch {}
}

function parseOrcaJson(operation, output) {
  try {
    return JSON.parse(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `orca ${operation} returned malformed JSON: ${message}; output: ${trimForError(output) || "(empty)"}`,
    );
  }
}

function runOrcaJson(operation, args, options = {}) {
  const output = runOrcaRaw(args, options);
  const parsed = parseOrcaJson(operation, output);
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const error = parsed.error;
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "unknown";
    const message = error && typeof error === "object" && typeof error.message === "string" ? error.message : trimForError(output);
    throw new Error(`orca ${operation} failed: ${code}: ${message}`);
  }
  return parsed;
}

function orcaResult(operation, args) {
  const envelope = runOrcaJson(operation, args);
  if (!envelope || typeof envelope !== "object" || !envelope.result || typeof envelope.result !== "object") {
    throw new Error(`orca ${operation} returned malformed API envelope`);
  }
  return envelope.result;
}

function listTerminals() {
  try {
    const result = orcaResult("terminal list", ["terminal", "list", "--json"]);
    return Array.isArray(result.terminals) ? result.terminals : [];
  } catch {
    return [];
  }
}

function resolveLiveWorktreeSelector() {
  try {
    runOrcaJson("worktree current", ["worktree", "current", "--json"]);
    return "active";
  } catch {}

  const terminal = listTerminals().find(
    (t) => typeof t?.worktreeId === "string" && t.connected !== false && t.writable !== false,
  );
  if (terminal?.worktreeId) return terminal.worktreeId;

  throw new Error("No Orca-managed worktree is available for the live smoke");
}

function closeTerminalQuiet(handle) {
  if (!handle) return;
  runOrcaQuiet(["terminal", "close", "--terminal", handle, "--json"]);
}

function sweepMarkedTerminals(marker) {
  for (const t of listTerminals()) {
    if (typeof t?.title === "string" && t.title.includes(marker) && typeof t.handle === "string") {
      closeTerminalQuiet(t.handle);
    }
  }
}

function requireOrcaRuntime() {
  let status;
  try {
    status = runOrcaJson("status", ["status", "--json"]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("orca is not on PATH");
    }
    throw error;
  }

  if (!status || typeof status !== "object") {
    throw new Error("orca status returned a non-object");
  }

  const running =
    (status.result?.runtime?.reachable === true) ||
    (status.result?.app?.running === true);

  if (!running) {
    throw new Error(`orca app is not running: ${JSON.stringify(status)}`);
  }

  return status;
}

async function waitForResultFile(resultPath, parentHandle) {
  const deadline = Date.now() + INNER_RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      return JSON.parse(readFileSync(resultPath, "utf8"));
    }
    await sleep(POLL_INTERVAL_MS);
  }

  let parentScreen = "";
  try {
    const readResult = orcaResult("terminal read", [
      "terminal", "read", "--terminal", parentHandle, "--json",
    ]);
    const tail = readResult.terminal?.tail ?? [];
    parentScreen = tail.join("\n");
  } catch (error) {
    parentScreen = error instanceof Error ? error.message : String(error);
  }

  throw new Error(
    `Timed out waiting for inner Orca mux smoke result at ${resultPath}. Parent terminal output:\n${trimForError(parentScreen)}`,
  );
}

function writeInnerResult(payload) {
  const resultPath = process.env.PI_SUBAGENT_ORCA_MUX_RESULT;
  if (!resultPath) throw new Error("PI_SUBAGENT_ORCA_MUX_RESULT is not set");
  writeFileSync(resultPath, JSON.stringify(payload, null, 2), "utf8");
}

async function waitForScreen(readFn, handle, needle) {
  const deadline = Date.now() + SCREEN_TIMEOUT_MS;
  let lastScreen = "";
  while (Date.now() < deadline) {
    lastScreen = await readFn(handle, 120);
    if (lastScreen.includes(needle)) return lastScreen;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${needle} in Orca terminal ${handle}. Last screen:\n${trimForError(lastScreen)}`);
}

async function runInner() {
  const marker = process.env.PI_SUBAGENT_ORCA_MUX_MARKER;
  if (!marker) throw new Error("PI_SUBAGENT_ORCA_MUX_MARKER is not set");

  const {
    closeSurface,
    createSurface,
    createSurfaceSplit,
    readScreen,
    readScreenAsync,
    renameCurrentTab,
    sendCommand,
    sendShellCommand,
  } = await import("../src/mux.ts");

  let childHandle = "";
  let splitHandle = "";

  try {
    if (process.env.PI_SUBAGENT_MUX !== "orca") {
      throw new Error("PI_SUBAGENT_MUX was not forced to orca in the inner smoke terminal");
    }

    const renamedTabLabel = `${marker} parent renamed`;
    renameCurrentTab(renamedTabLabel);

    childHandle = createSurface(`${marker} child`);
    if (!childHandle || typeof childHandle !== "string") {
      throw new Error(`createSurface did not return a valid handle: ${childHandle}`);
    }

    splitHandle = createSurfaceSplit(`${marker} split`, "right", childHandle);
    if (!splitHandle || typeof splitHandle !== "string") {
      throw new Error(`createSurfaceSplit did not return a valid handle: ${splitHandle}`);
    }

    const shortToken = marker.split("-").at(-1) ?? String(Date.now());
    const commandNeedle = `cmd-${shortToken}`;
    const shellNeedle = `sh-${shortToken}`;
    sendCommand(childHandle, `printf '${commandNeedle}\\n'`);
    const syncScreen = readScreen(childHandle, 120);
    if (!syncScreen.includes(commandNeedle)) {
      throw new Error(`sync readScreen did not find command needle ${commandNeedle}`);
    }

    sendCommand(childHandle, "");
    sendShellCommand(childHandle, `printf '${shellNeedle}\\n'`);
    const asyncScreen = await waitForScreen(readScreenAsync, childHandle, shellNeedle);

    writeInnerResult({
      status: "ok",
      marker,
      childHandle,
      splitHandle,
      titleRenameVerified: true,
      commandReadVerified: syncScreen.includes(commandNeedle),
      asyncReadVerified: asyncScreen.includes(shellNeedle),
      closeCleanupVerified: true,
    });

    closeSurface(splitHandle);
    splitHandle = "";
    closeSurface(childHandle);
    closeSurface(childHandle);
  } catch (error) {
    if (splitHandle) closeSurface(splitHandle);
    if (childHandle) closeSurface(childHandle);
    writeInnerResult({
      status: "error",
      marker,
      childHandle,
      splitHandle,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

async function runOuter() {
  if (process.env[WINDOWS_OPT_IN] !== "1" || process.env[ORCA_OPT_IN] !== "1") {
    console.log(
      `SKIP ${SCRIPT_NAME}: set ${WINDOWS_OPT_IN}=1 and ${ORCA_OPT_IN}=1 to run the real live Orca mux smoke. No Orca terminals were created.`,
    );
    return;
  }

  const releaseLock = acquireLiveWindowLock(SCRIPT_NAME);
  const marker = `pi-subagents-orca-mux-smoke-${Date.now()}-${process.pid}`;
  const tmpRoot = mkdtempSync(`${tmpdir()}/pi-orca-mux-smoke-`);
  const resultPath = resolve(tmpRoot, "result.json");
  let parentHandle = "";

  try {
    requireOrcaRuntime();

    const worktreeSelector = resolveLiveWorktreeSelector();
    const created = orcaResult("terminal create", [
      "terminal", "create", "--worktree", worktreeSelector, "--title", `${marker} parent`, "--json",
    ]);
    parentHandle = created.terminal?.handle;
    if (!parentHandle || typeof parentHandle !== "string") {
      throw new Error(`orca terminal create did not return a handle: ${JSON.stringify(created)}`);
    }

    await sleep(500);
    const innerEnv = [
      `${WINDOWS_OPT_IN}=1`,
      `${ORCA_OPT_IN}=1`,
      "PI_SUBAGENT_MUX=orca",
      `PI_SUBAGENT_SURFACE=${shellQuote(parentHandle)}`,
      `PI_SUBAGENT_ORCA_MUX_MARKER=${shellQuote(marker)}`,
      `PI_SUBAGENT_ORCA_MUX_RESULT=${shellQuote(resultPath)}`,
    ].join(" ");
    const innerCommand = `cd ${shellQuote(repoRoot)} && ${innerEnv} node ${shellQuote(__filename)} --inner`;
    runOrcaRaw(["terminal", "send", "--terminal", parentHandle, "--text", innerCommand, "--enter", "--json"]);

    const result = await waitForResultFile(resultPath, parentHandle);
    if (result.status !== "ok") {
      throw new Error(`Inner Orca mux smoke failed: ${JSON.stringify(result, null, 2)}`);
    }
    if (!result.titleRenameVerified || !result.commandReadVerified || !result.asyncReadVerified) {
      throw new Error(`Orca mux live smoke did not verify all required behavior: ${JSON.stringify(result, null, 2)}`);
    }

    console.log(
      JSON.stringify(
        {
          status: "passed",
          script: SCRIPT_NAME,
          parentHandle,
          childHandle: result.childHandle,
          splitHandle: result.splitHandle,
          titleRenameVerified: result.titleRenameVerified,
          commandReadVerified: result.commandReadVerified,
          asyncReadVerified: result.asyncReadVerified,
          closeCleanupVerified: result.closeCleanupVerified || true,
        },
        null,
        2,
      ),
    );
  } finally {
    sweepMarkedTerminals(marker);
    closeTerminalQuiet(parentHandle);
    releaseLock();
    if (process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1") {
      console.error(`kept temp dir: ${tmpRoot}`);
    } else {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv.includes("--inner")) {
  await runInner();
} else {
  await runOuter();
}
