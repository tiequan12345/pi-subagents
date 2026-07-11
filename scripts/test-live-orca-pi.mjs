#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireLiveWindowLock } from "./live-test-guard.mjs";

const SCRIPT_NAME = "test-live-orca-pi";
const WINDOWS_OPT_IN = "PI_SUBAGENT_ALLOW_LIVE_WINDOWS";
const ORCA_OPT_IN = "PI_SUBAGENT_ALLOW_LIVE_ORCA";
const LIVE_MODEL_ENV = "PI_SUBAGENT_LIVE_MODEL";
const ORCA_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 120_000;
const CHILD_WAIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");
const piBin = process.env.PI_E2E_PI_BIN ?? "pi";

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function trimForError(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}…` : trimmed;
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

function getParentScreen(parentHandle) {
  try {
    const result = orcaResult("terminal read", [
      "terminal", "read", "--terminal", parentHandle, "--json",
    ]);
    const tail = result.terminal?.tail ?? [];
    return tail.join("\n");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function waitForParentPiStartup(parentHandle) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastScreen = "";
  while (Date.now() < deadline) {
    lastScreen = getParentScreen(parentHandle);
    if (
      lastScreen.includes("escape interrupt") ||
      lastScreen.includes("Model scope:") ||
      lastScreen.includes("Press ctrl+o to show full startup help")
    ) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for parent Pi startup:\n${trimForError(lastScreen)}`);
}

async function waitForParentEditorText(parentHandle, text) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastScreen = "";
  while (Date.now() < deadline) {
    lastScreen = getParentScreen(parentHandle);
    if (lastScreen.includes(text)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for editor text ${text}:\n${trimForError(lastScreen)}`);
}

async function waitForChildTerminal(parentHandle, marker, agentName, childDoneText) {
  const deadline = Date.now() + CHILD_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const terminals = listTerminals();
    const child = terminals.find((t) => {
      if (t?.handle === parentHandle || typeof t?.handle !== "string") return false;
      const title = typeof t?.title === "string" ? t.title : "";
      const preview = typeof t?.preview === "string" ? t.preview : "";
      return [title, preview].some(
        (text) => text.includes(marker) || text.includes(`[${agentName}]`) || text.includes(childDoneText),
      );
    });
    if (child) return child.handle;
    await sleep(POLL_INTERVAL_MS);
  }
  return "";
}

async function runOuter() {
  if (process.env[WINDOWS_OPT_IN] !== "1" || process.env[ORCA_OPT_IN] !== "1") {
    console.log(
      `SKIP ${SCRIPT_NAME}: set ${WINDOWS_OPT_IN}=1 and ${ORCA_OPT_IN}=1 to run the real live Orca Pi smoke. No Orca terminals were created.`,
    );
    return;
  }

  if (!process.env[LIVE_MODEL_ENV]) {
    console.log(
      `SKIP ${SCRIPT_NAME}: set ${LIVE_MODEL_ENV}=provider/model[:thinking] to run the real live Orca Pi smoke. No Orca terminals were created.`,
    );
    return;
  }

  const liveModel = process.env[LIVE_MODEL_ENV];
  const releaseLock = acquireLiveWindowLock(SCRIPT_NAME);
  const marker = `pi-subagents-orca-pi-smoke-${Date.now()}-${process.pid}`;
  const agentName = "live-orca-child";
  const childName = `orca-${process.pid.toString(36)}-pi`;
  const doneText = "LIVE_ORCA_PI_DONE";
  const childDoneText = "LIVE_ORCA_PI_CHILD_OK";
  const childTitle = `${marker} child`;

  const tmpRoot = mkdtempSync(join(tmpdir(), "pi-orca-live-pi-"));
  const configDir = join(tmpRoot, "agent");
  const agentsDir = join(configDir, "agents");
  const sessionDir = join(tmpRoot, "sessions");
  const artifactsDir = join(tmpRoot, "artifacts");
  const workDir = join(tmpRoot, "work");

  let parentHandle = "";

  try {
    requireOrcaRuntime();

    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    // Copy user Pi config
    const envConfigDir = process.env.PI_CODING_AGENT_DIR;
    const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
      ? envConfigDir
      : join(homedir(), ".pi", "agent");
    for (const name of ["auth.json", "models.json", "mcp.json"]) {
      const source = join(sourceConfigDir, name);
      if (existsSync(source)) copyFileSync(source, join(configDir, name));
    }

    // Write child agent
    const [model, thinking] = liveModel.split(":", 2);
    const thinkingLine = thinking ? `thinking: ${thinking}\n` : "";
    writeFileSync(
      join(agentsDir, `${agentName}.md`),
      `---
name: ${agentName}
description: Live Orca Pi smoke child
mode: interactive
auto-exit: false
async: true
parent-close-policy: terminate
spawning: false
tools: bash
model: ${model}
${thinkingLine}trust-project: true
cwd: ${workDir}
---

You are the live Orca Pi child smoke probe.
Reply with exactly \`${childDoneText}\`, then stay open for operator interaction.
`,
      "utf8",
    );

    // Create parent terminal
    const worktreeSelector = resolveLiveWorktreeSelector();
    const created = orcaResult("terminal create", [
      "terminal", "create", "--worktree", worktreeSelector, "--title", `${marker} parent`, "--json",
    ]);
    parentHandle = created.terminal?.handle;
    if (!parentHandle || typeof parentHandle !== "string") {
      throw new Error(`orca terminal create did not return a handle: ${JSON.stringify(created)}`);
    }

    // Build and send parent pi command
    const unset = [
      "PI_SUBAGENT_AGENT",
      "PI_SUBAGENT_NAME",
      "PI_SUBAGENT_AUTO_EXIT",
      "PI_DENY_TOOLS",
      "PI_ARTIFACT_PROJECT_ROOT",
      "PI_SUBAGENT_MUX",
    ].map((key) => `-u ${key}`).join(" ");
    const assignments = [
      "PI_PACKAGE_DIR=",
      "PI_SUBAGENT_EXTENSIONS=",
      "PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS=1",
      "PI_SUBAGENT_SHELL_READY_DELAY_MS=1000",
      `PI_SUBAGENT_PI_COMMAND=${shellQuote(piBin)}`,
      `PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
      `PI_ARTIFACT_PROJECT_ROOT=${shellQuote(artifactsDir)}`,
      `PI_SUBAGENT_SURFACE=${shellQuote(parentHandle)}`,
      "PI_SUBAGENT_MUX=orca",
    ].join(" ");
    const args = [
      shellQuote(piBin),
      "--model",
      shellQuote(liveModel),
      "--no-approve",
      "--no-extensions",
      "-e",
      shellQuote(extensionSource),
      "--session-dir",
      shellQuote(sessionDir),
      "--no-context-files",
    ].join(" ");
    const command = `cd ${shellQuote(workDir)} && env ${unset} ${assignments} ${args}`;

    runOrcaRaw(["terminal", "send", "--terminal", parentHandle, "--text", command, "--enter", "--json"]);
    await waitForParentPiStartup(parentHandle);

    const prompt = `Call subagent with name "${childName}", agent "${agentName}", title "${childTitle}", task "Reply with exactly ${childDoneText}, then stay open for operator interaction.". After the subagent tool returns, reply exactly "${doneText}".`;
    runOrcaRaw(["terminal", "send", "--terminal", parentHandle, "--text", prompt, "--enter", "--json"]);

    // Wait for the submitted parent prompt to create a visible child pane.
    const childHandle = await waitForChildTerminal(parentHandle, marker, agentName, childDoneText);
    if (!childHandle) {
      const terminals = listTerminals().map((t) => ({
        handle: t?.handle,
        title: t?.title,
        worktreePath: t?.worktreePath,
        connected: t?.connected,
        writable: t?.writable,
      }));
      throw new Error(
        `No visible Orca child terminal appeared for agent ${agentName}. Interactive launch may have fallen back to background.\n` +
          `Parent screen:\n${trimForError(getParentScreen(parentHandle))}\n` +
          `Visible Orca terminals:\n${trimForError(JSON.stringify(terminals, null, 2))}`,
      );
    }

    closeTerminalQuiet(childHandle);
    const childClosed = !listTerminals().some((t) => t.handle === childHandle);

    console.log(
      JSON.stringify(
        {
          status: "passed",
          script: SCRIPT_NAME,
          liveModel,
          parentHandle,
          childHandle,
          childSurfaceFound: true,
          childSurfaceCleaned: childClosed,
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

await runOuter();
