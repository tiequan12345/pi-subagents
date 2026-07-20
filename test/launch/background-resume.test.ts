import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildBackgroundResumePlan,
	buildSubagentChildEnv,
	prepareRunningForRespawn,
} from "../../src/launch/background-resume.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import type { RunningSubagent } from "../../src/types.ts";

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
		sessionFile: "/tmp/s.jsonl",
		noSession: false,
		...overrides,
	} as RunningSubagent;
}

describe("buildSubagentChildEnv", () => {
	it("sets the core PI_SUBAGENT_* identity vars", () => {
		const env = buildSubagentChildEnv({
			envMetadata: undefined,
			extensions: undefined,
			name: "auth-scout",
			agent: "luna-agent",
			sessionFile: "/tmp/s.jsonl",
			autoExit: true,
		});
		assert.equal(env.PI_SUBAGENT_NAME, "auth-scout");
		assert.equal(env.PI_SUBAGENT_AGENT, "luna-agent");
		assert.equal(env.PI_SUBAGENT_SESSION, "/tmp/s.jsonl");
		assert.equal(env.PI_SUBAGENT_AUTO_EXIT, "1");
		assert.equal(env.PI_PACKAGE_DIR, "");
		assert.ok(env.PI_ARTIFACT_PROJECT_ROOT.length > 0);
	});

	it("omits PI_SUBAGENT_AUTO_EXIT when autoExit is false", () => {
		const env = buildSubagentChildEnv({
			envMetadata: undefined,
			extensions: undefined,
			name: "x",
			sessionFile: "/tmp/s.jsonl",
			autoExit: false,
		});
		assert.equal("PI_SUBAGENT_AUTO_EXIT" in env, false);
	});

	it("parses persisted env + denyTools + extensions from launch metadata", () => {
		const metadata = {
			env: "FOO=bar\nBAZ=qux",
			denyTools: ["dangerous_tool", "another"],
			extensions: ["./ext/a.ts", "./ext/b.ts"],
		} as Partial<PersistedSubagentLaunchMetadata> as PersistedSubagentLaunchMetadata;
		const env = buildSubagentChildEnv({
			envMetadata: metadata,
			extensions: metadata.extensions,
			name: "x",
			sessionFile: "/tmp/s.jsonl",
			autoExit: true,
		});
		assert.equal(env.FOO, "bar");
		assert.equal(env.BAZ, "qux");
		assert.equal(env.PI_DENY_TOOLS, "dangerous_tool,another");
		assert.equal(env.PI_SUBAGENT_EXTENSIONS, "./ext/a.ts,./ext/b.ts");
	});

	it("falls back to the parent process env for unset optional vars", () => {
		const restore = process.env.PI_DENY_TOOLS;
		process.env.PI_DENY_TOOLS = "from_parent";
		try {
			const env = buildSubagentChildEnv({
				envMetadata: undefined,
				extensions: undefined,
				name: "x",
				sessionFile: "/tmp/s.jsonl",
				autoExit: true,
			});
			assert.equal(env.PI_DENY_TOOLS, "from_parent");
		} finally {
			if (restore === undefined) delete process.env.PI_DENY_TOOLS;
			else process.env.PI_DENY_TOOLS = restore;
		}
	});
});

describe("prepareRunningForRespawn", () => {
	it("resets launchEntryCount to the current entry count and clears the exit sidecar", () => {
		const sessionFile = join(tmpdir(), `respawn-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
		writeFileSync(sessionFile, '{"role":"user"}\n{"role":"assistant"}\n{"role":"user"}\n');
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "WebSocket error" }));
		const running = bgRunning({ sessionFile, launchEntryCount: 0 });
		try {
			prepareRunningForRespawn(running);
			assert.equal(running.launchEntryCount, 3);
			assert.equal(existsSync(`${sessionFile}.exit`), false);
		} finally {
			rmSync(sessionFile, { force: true });
			rmSync(`${sessionFile}.exit`, { force: true });
		}
	});

	it("throws when the running child has no session file", () => {
		const running = bgRunning({ sessionFile: undefined });
		assert.throws(() => prepareRunningForRespawn(running), /session file/);
	});
});

describe("buildBackgroundResumePlan delegated auth", () => {
	it("keeps persisted extensions and re-prepares runtime-dir env", async () => {
		const sessionFile = join(
			tmpdir(),
			`bg-resume-auth-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
		);
		writeFileSync(sessionFile, "{}\n");
		const globalScope = globalThis as typeof globalThis & {
			__piDelegatedAuthBrokerRegistry?: { list: () => unknown[] };
		};
		const previous = globalScope.__piDelegatedAuthBrokerRegistry;
		globalScope.__piDelegatedAuthBrokerRegistry = {
			list: () => [
				{
					id: "pi-multi-auth",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => ({
						mode: "self-managed",
						extensionDirs: ["/abs/pi-multi-auth"],
						env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/resume/runtime" },
					}),
				},
			],
		};
		try {
			const metadata = {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "codex-child",
				mode: "background",
				sessionMode: "standalone",
				parentClosePolicy: "terminate",
				async: true,
				model: "openai-codex/gpt-5.6-luna",
				modelRef: "openai-codex/gpt-5.6-luna:xhigh",
				extensions: ["npm:pi-mcp-adapter", "/abs/pi-multi-auth"],
				requiredExtensions: ["/abs/pi-multi-auth"],
				delegatedAuth: { brokerId: "pi-multi-auth", mode: "self-managed" },
				env: "PI_DELEGATED_AUTH_RUNTIME_DIR=/spoofed",
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				trustProject: false,
				allowModelOverride: true,
				boundarySystemPrompt: false,
				agentConfigDir: "/tmp/agent",
				cwd: "/tmp",
			} as PersistedSubagentLaunchMetadata;
			const plan = await buildBackgroundResumePlan(sessionFile, metadata, {
				parentClosePolicy: "terminate",
				displayName: "codex-child",
				autoExit: true,
			});
			assert.equal(plan.env.PI_DELEGATED_AUTH_RUNTIME_DIR, "/resume/runtime");
			assert.equal(
				plan.env.PI_SUBAGENT_EXTENSIONS,
				"npm:pi-mcp-adapter,/abs/pi-multi-auth",
			);
			assert.ok(plan.invocation.args.includes("/abs/pi-multi-auth"));
			assert.ok(plan.invocation.args.includes("npm:pi-mcp-adapter"));
		} finally {
			if (previous) globalScope.__piDelegatedAuthBrokerRegistry = previous;
			else delete globalScope.__piDelegatedAuthBrokerRegistry;
			rmSync(sessionFile, { force: true });
		}
	});

	it("resumes all-extensions metadata with required -e and without --no-extensions", async () => {
		const sessionFile = join(
			tmpdir(),
			`bg-resume-all-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
		);
		writeFileSync(sessionFile, "{}\n");
		const globalScope = globalThis as typeof globalThis & {
			__piDelegatedAuthBrokerRegistry?: { list: () => unknown[] };
		};
		const previous = globalScope.__piDelegatedAuthBrokerRegistry;
		let prepareCalls = 0;
		globalScope.__piDelegatedAuthBrokerRegistry = {
			list: () => [
				{
					id: "pi-multi-auth",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => {
						prepareCalls += 1;
						return {
							mode: "self-managed",
							extensionDirs: ["/abs/pi-multi-auth"],
							env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/resume/runtime" },
						};
					},
				},
			],
		};
		try {
			const metadata = {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "open-child",
				mode: "background",
				sessionMode: "standalone",
				parentClosePolicy: "terminate",
				async: true,
				model: "openai-codex/gpt-5.6-luna",
				modelRef: "openai-codex/gpt-5.6-luna:low",
				requiredExtensions: ["/abs/pi-multi-auth"],
				delegatedAuth: { brokerId: "pi-multi-auth", mode: "self-managed" },
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				trustProject: false,
				allowModelOverride: true,
				boundarySystemPrompt: false,
				agentConfigDir: "/tmp/agent",
				cwd: "/tmp",
			} as PersistedSubagentLaunchMetadata;
			const plan = await buildBackgroundResumePlan(sessionFile, metadata, {
				parentClosePolicy: "terminate",
				displayName: "open-child",
				autoExit: true,
			});
			assert.equal(prepareCalls, 1);
			assert.equal(plan.env.PI_DELEGATED_AUTH_RUNTIME_DIR, "/resume/runtime");
			assert.ok(plan.invocation.args.includes("/abs/pi-multi-auth"));
			assert.equal(plan.invocation.args.includes("--no-extensions"), false);
		} finally {
			if (previous) globalScope.__piDelegatedAuthBrokerRegistry = previous;
			else delete globalScope.__piDelegatedAuthBrokerRegistry;
			rmSync(sessionFile, { force: true });
		}
	});

	it("fails resume when a required delegated-auth broker is unavailable", async () => {
		const sessionFile = join(
			tmpdir(),
			`bg-resume-req-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
		);
		writeFileSync(sessionFile, "{}\n");
		const globalScope = globalThis as typeof globalThis & {
			__piDelegatedAuthBrokerRegistry?: { list: () => unknown[] };
		};
		const previous = globalScope.__piDelegatedAuthBrokerRegistry;
		delete globalScope.__piDelegatedAuthBrokerRegistry;
		try {
			const metadata = {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "codex-child",
				mode: "background",
				sessionMode: "standalone",
				parentClosePolicy: "terminate",
				async: true,
				model: "openai-codex/gpt-5.6-luna",
				extensions: ["npm:pi-mcp-adapter", "/abs/pi-multi-auth"],
				requiredExtensions: ["/abs/pi-multi-auth"],
				delegatedAuth: { brokerId: "pi-multi-auth", mode: "self-managed" },
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				trustProject: false,
				allowModelOverride: true,
				boundarySystemPrompt: false,
				agentConfigDir: "/tmp/agent",
				cwd: "/tmp",
			} as PersistedSubagentLaunchMetadata;
			await assert.rejects(
				() =>
					buildBackgroundResumePlan(sessionFile, metadata, {
						parentClosePolicy: "terminate",
						displayName: "codex-child",
						autoExit: true,
					}),
				/required for this session but did not prepare auth/,
			);
		} finally {
			if (previous) globalScope.__piDelegatedAuthBrokerRegistry = previous;
			rmSync(sessionFile, { force: true });
		}
	});
});
