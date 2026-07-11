import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import { getPiInvocation, getSubagentChildProcessEnv } from "./child-command.ts";
import { parseEnvString } from "./env.ts";
import {
	getExtensionLaunchArgs,
	getPersistedPromptLaunchArgs,
	getPersistedSessionParityArgs,
} from "./prep.ts";
import { buildResumePiArgs, getResumeCwd, resolveResumeLaunchMetadata } from "./resume.ts";
import { clearSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { getEntryCount } from "../session/session.ts";
import {
	readSubagentExtensionEntry,
	readSubagentLaunchMetadata,
	type PersistedSubagentLaunchMetadata,
} from "../session/session-files.ts";
import type { ParentClosePolicy, RunningSubagent } from "../types.ts";

const TAIL_BYTES = 4000;
const RESPAWN_CONTINUE_NUDGE = "continue";

function subagentDonePath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "subagent-done.ts");
}

function backgroundResumeStdio(
	parentClosePolicy: ParentClosePolicy,
): ("pipe" | "ignore")[] {
	return parentClosePolicy === "continue"
		? ["pipe", "ignore", "ignore"]
		: ["pipe", "pipe", "pipe"];
}

function attachSubagentChildTails(running: RunningSubagent): void {
	const child = running.childProcess;
	if (!child) return;
	const remember = (current: string | undefined, chunk: Buffer | string) =>
		`${current ?? ""}${chunk.toString()}`.slice(-TAIL_BYTES);
	child.stdout?.on("data", (chunk: Buffer) => {
		running.stdoutTail = remember(running.stdoutTail, chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		running.stderrTail = remember(running.stderrTail, chunk);
	});
}

/**
 * Build the child-process env overlay for a resumed/respawned child from the
 * persisted launch metadata. Shared by resume-service (both interactive and
 * background branches) and background retry so the env contract lives in one
 * place. Callers resolve the two metadata sources (invocation override vs
 * session default) into the explicit fields here; the result is an overlay that
 * `getSubagentChildProcessEnv` merges with the parent process env at spawn time.
 */
export function buildSubagentChildEnv(options: {
	envMetadata: PersistedSubagentLaunchMetadata | undefined;
	extensions: string[] | undefined;
	name: string;
	agent?: string;
	sessionFile: string;
	autoExit: boolean;
}): Record<string, string> {
	const { envMetadata, extensions, name, agent, sessionFile, autoExit } = options;
	const env: Record<string, string> = {};
	// Restore user-configured env vars from the original launch FIRST, so the
	// internal PI vars below can override them if needed.
	if (envMetadata?.env) Object.assign(env, parseEnvString(envMetadata.env));
	if (envMetadata?.agentConfigDir) {
		env.PI_CODING_AGENT_DIR = envMetadata.agentConfigDir;
	} else if (process.env.PI_CODING_AGENT_DIR) {
		env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	if (envMetadata?.denyTools?.length) {
		env.PI_DENY_TOOLS = envMetadata.denyTools.join(",");
	} else if (process.env.PI_DENY_TOOLS) {
		env.PI_DENY_TOOLS = process.env.PI_DENY_TOOLS;
	}
	if (extensions !== undefined) {
		env.PI_SUBAGENT_EXTENSIONS = extensions.join(",");
	} else if (process.env.PI_SUBAGENT_EXTENSIONS) {
		env.PI_SUBAGENT_EXTENSIONS = process.env.PI_SUBAGENT_EXTENSIONS;
	}
	if (process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE === "1") {
		env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
	}
	env.PI_SUBAGENT_NAME = name;
	if (agent) env.PI_SUBAGENT_AGENT = agent;
	env.PI_SUBAGENT_SESSION = sessionFile;
	if (autoExit) env.PI_SUBAGENT_AUTO_EXIT = "1";
	env.PI_PACKAGE_DIR = "";
	env.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();
	return env;
}

export interface BackgroundResumePlan {
	invocation: { command: string; args: string[] };
	cwd: string | undefined;
	/** PI_* overlay; merged with the parent process env at spawn time. */
	env: Record<string, string>;
	stdio: ("pipe" | "ignore")[];
}

/**
 * The canonical background resume launch plan: pi invocation, cwd, env overlay,
 * and stdio. Consumed by both operator resume (resume-service) and the retry
 * respawn so there is exactly one place that assembles resume args + env.
 */
export async function buildBackgroundResumePlan(
	sessionFile: string,
	invocationMetadata: PersistedSubagentLaunchMetadata | undefined,
	options: {
		parentClosePolicy: ParentClosePolicy;
		displayName: string;
		agent?: string;
		autoExit: boolean;
	},
): Promise<BackgroundResumePlan> {
	const extensions =
		invocationMetadata?.extensions ?? readSubagentExtensionEntry(sessionFile);
	const extensionArgs = extensions
		? getExtensionLaunchArgs(extensions, subagentDonePath())
		: ["--no-extensions", "-e", subagentDonePath()];
	const parityArgs = [
		...getPersistedPromptLaunchArgs(invocationMetadata),
		...(await getPersistedSessionParityArgs(invocationMetadata, "background")),
		...(invocationMetadata ? [] : ["--no-approve"]),
	];
	const invocation = getPiInvocation([
		...buildResumePiArgs(sessionFile, "background"),
		...extensionArgs,
		...parityArgs,
	]);
	return {
		invocation,
		cwd: getResumeCwd(invocationMetadata),
		env: buildSubagentChildEnv({
			envMetadata: invocationMetadata,
			extensions,
			name: invocationMetadata?.name ?? options.displayName,
			agent: invocationMetadata?.agent ?? options.agent,
			sessionFile,
			autoExit: options.autoExit,
		}),
		stdio: backgroundResumeStdio(options.parentClosePolicy),
	};
}

/**
 * Spawn a background resume child from a plan onto `running`, owning child
 * assignment, tail reset, and tail capture. Shared by resume-service and retry.
 */
export function spawnBackgroundResumeChild(
	running: RunningSubagent,
	plan: BackgroundResumePlan,
	stdin?: string,
): ChildProcess {
	const child = spawn(plan.invocation.command, plan.invocation.args, {
		...(plan.cwd ? { cwd: plan.cwd } : {}),
		detached: true,
		stdio: plan.stdio,
		env: getSubagentChildProcessEnv(plan.invocation, plan.env),
	});
	if (stdin !== undefined) child.stdin?.end(stdin);
	else child.stdin?.end();
	child.unref();
	running.childProcess = child;
	running.stdoutTail = undefined;
	running.stderrTail = undefined;
	attachSubagentChildTails(running);
	return child;
}

/**
 * Reset attempt-scoped state on a running child before respawning, so the next
 * watch does not see the failed attempt's terminal assistant summary as the new
 * run's stable output (which would reap the respawned child within
 * terminalGraceMs) and does not double-count its entries. Mirrors
 * resume-service's `entryCountBefore` on a fresh running.
 */
export function prepareRunningForRespawn(running: RunningSubagent): void {
	if (!running.sessionFile) {
		throw new Error("Cannot respawn a background child without a session file.");
	}
	running.launchEntryCount = getEntryCount(running.sessionFile);
	clearSubagentExitSidecar(running.sessionFile);
}

/**
 * Re-spawn a background child in place after a transient provider error, on the
 * same session file, sending a "continue" nudge so the agent retries its last
 * turn. Keeps the RunningSubagent identity stable (no registry churn). Used by
 * the background retry coordinator.
 */
export async function respawnBackgroundChild(running: RunningSubagent): Promise<void> {
	if (!running.sessionFile) {
		throw new Error("Cannot respawn a background child without a session file.");
	}
	const launchMetadata = readSubagentLaunchMetadata(running.sessionFile);
	const metadata = resolveResumeLaunchMetadata(running.sessionFile, undefined);
	if (metadata.mode !== "background") {
		throw new Error(`Cannot respawn non-background child (mode=${metadata.mode}).`);
	}
	const autoExit = launchMetadata?.autoExit ?? metadata.autoExit ?? true;
	const plan = await buildBackgroundResumePlan(running.sessionFile, launchMetadata, {
		parentClosePolicy: running.parentClosePolicy,
		displayName: running.name,
		agent: running.agent,
		autoExit,
	});
	prepareRunningForRespawn(running);
	spawnBackgroundResumeChild(running, plan, RESPAWN_CONTINUE_NUDGE);
}
