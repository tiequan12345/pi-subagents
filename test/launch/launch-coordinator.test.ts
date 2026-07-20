import {
	ASSISTANT_MSG,
	MODEL_CHANGE,
	SESSION_HEADER,
	USER_MSG,
	assert,
	createTestDir,
	describe,
	getEntries,
	it,
	join,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "../support/index.ts";
import { coordinateSubagentLaunch } from "../../src/launch/launch-coordinator.ts";
import { getPreparedExtensionLaunchArgs } from "../../src/launch/prep.ts";

describe("launch coordinator", () => {
	it("prepares, seeds, persists, and returns common launch facts", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "scout.md"),
			[
				"---",
				"name: scout",
				"session-mode: fork",
				"mode: background",
				"auto-exit: true",
				"model: provider/model",
				"thinking: high",
				"tools: read,bash",
				"deny-tools: bash",
				"skills: none",
				"extensions: none",
				"trust-project: true",
				"---",
				"You scout the codebase.",
			].join("\n"),
		);
		const parentSession = join(cwd, "parent.jsonl");
		writeFileSync(
			parentSession,
			`${[SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const launch = await coordinateSubagentLaunch(
			{
				name: "code-scout",
				title: "Code scout",
				task: "Map launch code",
				agent: "scout",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{ mode: "background" },
		);

		assert.equal(launch.sessionMode, "fork");
		assert.equal(launch.noSession, false);
		assert.equal(launch.directTask, true);
		assert.equal(launch.seedMode, "fork");
		assert.equal(launch.boundarySystemPrompt, true);
		assert.equal(launch.launchMetadata.mode, "background");
		assert.equal(launch.launchMetadata.sessionMode, "fork");
		assert.equal(launch.launchMetadata.modelRef, "provider/model:high");
		assert.equal(launch.launchMetadata.trustProject, true);
		assert.equal(launch.envVars.PI_SUBAGENT_SESSION, launch.prepared.subagentSessionFile);
		assert.equal(launch.envVars.PI_SUBAGENT_AUTO_EXIT, "1");
		assert.deepEqual(launch.envVars.PI_DENY_TOOLS.split(",").sort(), [
			"bash",
			"subagent",
			"subagent_resume",
		]);

		const entries = getEntries(launch.prepared.subagentSessionFile) as Array<Record<string, unknown>>;
		assert.equal(entries[0].type, "session");
		assert.equal(entries.some((entry) => entry.customType === "subagent_boundary"), true);
		assert.equal(entries.some((entry) => entry.type === "model_change"), true);
		assert.equal(entries.some((entry) => entry.type === "thinking_level_change"), true);
		assert.equal(entries.some((entry) => entry.customType === "pi-subagents_launch_metadata"), true);
		assert.equal(launch.launchEntryCount, entries.length);
	});

	it("persists identity system prompt without changing the child session path", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "reviewer.md"),
			[
				"---",
				"name: reviewer",
				"system-prompt: append",
				"---",
				"You are the reviewer identity.",
			].join("\n"),
		);
		const parentSession = join(cwd, "parent-system-prompt.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);

		const launch = await coordinateSubagentLaunch(
			{
				name: "diff-reviewer",
				title: "Diff reviewer",
				task: "Review the diff",
				agent: "reviewer",
				systemPrompt: "Focus on material findings.",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => null,
				},
			},
			{ mode: "background" },
		);

		assert.equal(launch.systemPrompt?.flag, "--append-system-prompt");
		assert.match(launch.systemPrompt?.text ?? "", /You are the reviewer identity/);
		assert.match(launch.systemPrompt?.text ?? "", /Focus on material findings/);
		assert.equal(launch.launchMetadata.systemPrompt, launch.systemPrompt?.text);
		assert.equal(launch.envVars.PI_SUBAGENT_SESSION, launch.prepared.subagentSessionFile);

		const metadataEntries = (getEntries(launch.prepared.subagentSessionFile) as Array<Record<string, unknown>>)
			.filter((entry) => entry.customType === "pi-subagents_launch_metadata");
		assert.equal(metadataEntries.length, 1);
	});

	it("injects self-managed delegated auth before seed and metadata", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "codex.md"),
			[
				"---",
				"name: codex",
				"model: openai-codex/gpt-5.6-luna",
				"extensions: npm:pi-mcp-adapter",
				"env: |",
				"  PI_DELEGATED_AUTH_RUNTIME_DIR=/spoofed",
				"---",
				"Codex child.",
			].join("\n"),
		);
		const parentSession = join(cwd, "parent-auth.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);

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
						env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/abs/runtime" },
					}),
				},
			],
		};
		try {
			const launch = await coordinateSubagentLaunch(
				{
					name: "codex-child",
					title: "Codex child",
					task: "Use selected account",
					agent: "codex",
				},
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => null,
					},
				},
				{ mode: "background" },
			);

			assert.deepEqual(launch.prepared.effectiveExtensions, [
				"npm:pi-mcp-adapter",
				"/abs/pi-multi-auth",
			]);
			assert.deepEqual(launch.prepared.requiredExtensions, ["/abs/pi-multi-auth"]);
			assert.deepEqual(launch.launchMetadata.extensions, [
				"npm:pi-mcp-adapter",
				"/abs/pi-multi-auth",
			]);
			assert.deepEqual(launch.launchMetadata.requiredExtensions, [
				"/abs/pi-multi-auth",
			]);
			assert.deepEqual(launch.launchMetadata.delegatedAuth, {
				brokerId: "pi-multi-auth",
				mode: "self-managed",
			});
			assert.equal(
				launch.envVars.PI_SUBAGENT_EXTENSIONS,
				"npm:pi-mcp-adapter,/abs/pi-multi-auth",
			);
			assert.equal(launch.envVars.PI_DELEGATED_AUTH_RUNTIME_DIR, "/abs/runtime");

			const extensionSidecar = JSON.parse(
				readFileSync(`${launch.prepared.subagentSessionFile}.ext`, "utf8"),
			) as { extensions?: string[] };
			assert.deepEqual(extensionSidecar.extensions, [
				"npm:pi-mcp-adapter",
				"/abs/pi-multi-auth",
			]);
		} finally {
			if (previous) globalScope.__piDelegatedAuthBrokerRegistry = previous;
			else delete globalScope.__piDelegatedAuthBrokerRegistry;
		}
	});

	it("keeps all-extensions defaults and records required broker -e paths", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "open.md"),
			[
				"---",
				"name: open",
				"model: openai-codex/gpt-5.6-luna",
				"extensions: all",
				"---",
				"Open child.",
			].join("\n"),
		);
		const parentSession = join(cwd, "parent-all-ext.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);

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
						env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/abs/runtime" },
					}),
				},
			],
		};
		try {
			const launch = await coordinateSubagentLaunch(
				{
					name: "open-child",
					title: "Open child",
					task: "Use default extensions",
					agent: "open",
				},
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => null,
					},
				},
				{ mode: "background" },
			);
			assert.equal(launch.prepared.effectiveExtensions, undefined);
			assert.deepEqual(launch.prepared.requiredExtensions, ["/abs/pi-multi-auth"]);
			assert.equal(launch.launchMetadata.extensions, undefined);
			assert.deepEqual(launch.launchMetadata.requiredExtensions, [
				"/abs/pi-multi-auth",
			]);
			assert.deepEqual(launch.launchMetadata.delegatedAuth, {
				brokerId: "pi-multi-auth",
				mode: "self-managed",
			});
			assert.equal(launch.envVars.PI_DELEGATED_AUTH_RUNTIME_DIR, "/abs/runtime");

			const args = getPreparedExtensionLaunchArgs(
				launch.prepared,
				"/tmp/subagent-done.ts",
			);
			assert.ok(!args.includes("--no-extensions"));
			assert.ok(args.includes("/abs/pi-multi-auth"));
		} finally {
			if (previous) globalScope.__piDelegatedAuthBrokerRegistry = previous;
			else delete globalScope.__piDelegatedAuthBrokerRegistry;
		}
	});
});
