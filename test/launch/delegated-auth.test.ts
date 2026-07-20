import {
	assert,
	describe,
	it,
} from "../support/index.ts";
import {
	applyDelegatedAuthEnvOverlay,
	applyDelegatedAuthExtensions,
	buildDelegatedAuthRequest,
	maskInheritedDelegatedAuthEnv,
	mergeDelegatedAuthEnv,
	resolveDelegatedAuthOverlay,
	splitProviderModel,
	stripReservedDelegatedAuthEnv,
	type DelegatedAuthLaunchOverlay,
} from "../../src/launch/delegated-auth.ts";
import { getSubagentChildProcessEnv } from "../../src/launch/child-command.ts";
import {
	getExtensionLaunchArgs,
	resolveResumeExtensionLaunchArgs,
} from "../../src/launch/prep.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";

type FakeBroker = {
	id: string;
	capabilities: readonly string[];
	prepareSubagentAuth: (request: unknown) => unknown;
};

type FakeRegistry = {
	list: () => FakeBroker[];
};

type GlobalWithRegistry = typeof globalThis & {
	__piDelegatedAuthBrokerRegistry?: FakeRegistry;
};

function withRegistry<T>(brokers: FakeBroker[], run: () => Promise<T> | T): Promise<T> | T {
	const globalScope = globalThis as GlobalWithRegistry;
	const previous = globalScope.__piDelegatedAuthBrokerRegistry;
	globalScope.__piDelegatedAuthBrokerRegistry = {
		list: () => brokers,
	};
	const restore = () => {
		if (previous) globalScope.__piDelegatedAuthBrokerRegistry = previous;
		else delete globalScope.__piDelegatedAuthBrokerRegistry;
	};
	try {
		const result = run();
		if (result && typeof (result as Promise<T>).then === "function") {
			return (result as Promise<T>).finally(restore);
		}
		restore();
		return result;
	} catch (error) {
		restore();
		throw error;
	}
}

describe("delegated auth helper", () => {
	it("splits provider/model refs", () => {
		assert.deepEqual(splitProviderModel("openai-codex/gpt-5.6-luna"), {
			providerId: "openai-codex",
			modelId: "gpt-5.6-luna",
		});
		assert.deepEqual(splitProviderModel(undefined), {});
		assert.deepEqual(splitProviderModel("bare-model"), { modelId: "bare-model" });
	});

	it("builds prepare requests from launch facts", () => {
		assert.deepEqual(
			buildDelegatedAuthRequest({
				effectiveModel: "openai-codex/gpt-5.6-luna",
				effectiveModelRef: "openai-codex/gpt-5.6-luna:xhigh",
				parentSessionId: "parent-1",
				subagentSessionId: "/tmp/child.jsonl",
			}),
			{
				providerId: "openai-codex",
				modelId: "gpt-5.6-luna",
				modelRef: "openai-codex/gpt-5.6-luna:xhigh",
				parentSessionId: "parent-1",
				subagentSessionId: "/tmp/child.jsonl",
			},
		);
	});

	it("returns undefined when no registry is present", async () => {
		const globalScope = globalThis as GlobalWithRegistry;
		const previous = globalScope.__piDelegatedAuthBrokerRegistry;
		delete globalScope.__piDelegatedAuthBrokerRegistry;
		try {
			const overlay = await resolveDelegatedAuthOverlay({
				providerId: "openai-codex",
				modelId: "gpt-5.6-luna",
				subagentSessionId: "/tmp/child.jsonl",
			});
			assert.equal(overlay, undefined);
		} finally {
			if (previous) globalScope.__piDelegatedAuthBrokerRegistry = previous;
		}
	});

	it("ignores mode none and applies the first self-managed broker", async () => {
		await withRegistry(
			[
				{
					id: "noop",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => ({ mode: "none" }),
				},
				{
					id: "pi-multi-auth",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: (request) => {
						assert.equal(
							(request as { providerId?: string }).providerId,
							"openai-codex",
						);
						return {
							mode: "self-managed",
							extensionDirs: ["/abs/pi-multi-auth"],
							env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/abs/runtime" },
						};
					},
				},
			],
			async () => {
				const overlay = await resolveDelegatedAuthOverlay({
					providerId: "openai-codex",
					modelId: "gpt-5.6-luna",
					subagentSessionId: "/tmp/child.jsonl",
				});
				assert.deepEqual(overlay, {
					brokerId: "pi-multi-auth",
					mode: "self-managed",
					extensionDirs: ["/abs/pi-multi-auth"],
					env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/abs/runtime" },
				});
			},
		);
	});

	it("hard-fails on unsupported lease mode", async () => {
		await withRegistry(
			[
				{
					id: "pi-multi-auth",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => ({
						mode: "lease",
						leaseId: "lease-1",
						env: { PI_DELEGATED_AUTH_API_KEY: "secret" },
					}),
				},
			],
			async () => {
				await assert.rejects(
					() =>
						resolveDelegatedAuthOverlay({
							providerId: "openai-codex",
							modelId: "gpt",
							subagentSessionId: "/tmp/child.jsonl",
						}),
					/unsupported mode "lease"/,
				);
			},
		);
	});

	it("hard-fails on malformed or unknown broker modes", async () => {
		await withRegistry(
			[
				{
					id: "bad",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => undefined,
				},
			],
			async () => {
				await assert.rejects(
					() =>
						resolveDelegatedAuthOverlay({
							providerId: "openai-codex",
							modelId: "gpt",
							subagentSessionId: "/tmp/child.jsonl",
						}),
					/invalid result/,
				);
			},
		);
		await withRegistry(
			[
				{
					id: "weird",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => ({ mode: "surprise" }),
				},
			],
			async () => {
				await assert.rejects(
					() =>
						resolveDelegatedAuthOverlay({
							providerId: "openai-codex",
							modelId: "gpt",
							subagentSessionId: "/tmp/child.jsonl",
						}),
					/unsupported mode "surprise"/,
				);
			},
		);
	});

	it("rejects relative extension dirs", async () => {
		await withRegistry(
			[
				{
					id: "pi-multi-auth",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => ({
						mode: "self-managed",
						extensionDirs: ["relative/path"],
					}),
				},
			],
			async () => {
				await assert.rejects(
					() =>
						resolveDelegatedAuthOverlay({
							providerId: "openai-codex",
							modelId: "gpt",
							subagentSessionId: "/tmp/child.jsonl",
						}),
					/must be an absolute path/,
				);
			},
		);
	});

	it("tracks required dirs for all-extensions and merges explicit allowlists", () => {
		assert.deepEqual(
			applyDelegatedAuthExtensions(undefined, ["/abs/pi-multi-auth"]),
			{
				effectiveExtensions: undefined,
				requiredExtensions: ["/abs/pi-multi-auth"],
			},
		);
		assert.deepEqual(
			applyDelegatedAuthExtensions(["npm:pi-mcp-adapter"], ["/abs/pi-multi-auth"]),
			{
				effectiveExtensions: ["npm:pi-mcp-adapter", "/abs/pi-multi-auth"],
				requiredExtensions: ["/abs/pi-multi-auth"],
			},
		);
		assert.deepEqual(
			applyDelegatedAuthExtensions(
				["npm:pi-mcp-adapter", "/abs/pi-multi-auth"],
				["/abs/pi-multi-auth"],
			),
			{
				effectiveExtensions: ["npm:pi-mcp-adapter", "/abs/pi-multi-auth"],
				requiredExtensions: ["/abs/pi-multi-auth"],
			},
		);
	});

	it("adds required -e paths without forcing --no-extensions for defaults", () => {
		assert.deepEqual(
			getExtensionLaunchArgs(undefined, "/done.ts", ["/abs/pi-multi-auth"]),
			["-e", "/done.ts", "-e", "/abs/pi-multi-auth"],
		);
		assert.deepEqual(
			getExtensionLaunchArgs(
				["npm:pi-mcp-adapter"],
				"/done.ts",
				["/abs/pi-multi-auth"],
			),
			[
				"--no-extensions",
				"-e",
				"/done.ts",
				"-e",
				"npm:pi-mcp-adapter",
				"-e",
				"/abs/pi-multi-auth",
			],
		);
	});

	it("treats metadata without extensions as defaults on resume", () => {
		const metadata = {
			requiredExtensions: ["/abs/pi-multi-auth"],
		} as PersistedSubagentLaunchMetadata;
		const resolved = resolveResumeExtensionLaunchArgs(
			"/tmp/missing.jsonl",
			metadata,
			"/done.ts",
		);
		assert.equal(resolved.extensions, undefined);
		assert.deepEqual(resolved.args, [
			"-e",
			"/done.ts",
			"-e",
			"/abs/pi-multi-auth",
		]);
		assert.ok(!resolved.args.includes("--no-extensions"));
	});

	it("strips reserved delegated-auth env keys", () => {
		const env = stripReservedDelegatedAuthEnv({
			PI_DELEGATED_AUTH_RUNTIME_DIR: "/spoof",
			PI_AGENT_ROUTER_SUBAGENT: "1",
			FOO: "bar",
		});
		assert.equal(env.FOO, "bar");
		assert.equal("PI_DELEGATED_AUTH_RUNTIME_DIR" in env, false);
		assert.equal("PI_AGENT_ROUTER_SUBAGENT" in env, false);
	});

	it("lets broker env win over frontmatter", () => {
		const overlay: DelegatedAuthLaunchOverlay = {
			brokerId: "pi-multi-auth",
			mode: "self-managed",
			extensionDirs: ["/abs/pi-multi-auth"],
			env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/broker/runtime" },
		};
		const env = mergeDelegatedAuthEnv(
			{
				PI_DELEGATED_AUTH_RUNTIME_DIR: "/spoofed",
				FOO: "bar",
			},
			overlay,
		);
		assert.equal(env.PI_DELEGATED_AUTH_RUNTIME_DIR, "/broker/runtime");
		assert.equal(env.FOO, "bar");
	});

	it("scrubs inherited process env lease secrets from background child env", () => {
		const restore: Record<string, string | undefined> = {
			PI_AGENT_ROUTER_SUBAGENT: process.env.PI_AGENT_ROUTER_SUBAGENT,
			PI_DELEGATED_AUTH_API_KEY: process.env.PI_DELEGATED_AUTH_API_KEY,
			PI_DELEGATED_AUTH_LEASE_ID: process.env.PI_DELEGATED_AUTH_LEASE_ID,
			PI_DELEGATED_AUTH_PROVIDER_ID: process.env.PI_DELEGATED_AUTH_PROVIDER_ID,
			PI_DELEGATED_AUTH_RUNTIME_DIR: process.env.PI_DELEGATED_AUTH_RUNTIME_DIR,
		};
		process.env.PI_AGENT_ROUTER_SUBAGENT = "1";
		process.env.PI_DELEGATED_AUTH_API_KEY = "parent-secret";
		process.env.PI_DELEGATED_AUTH_LEASE_ID = "parent-lease";
		process.env.PI_DELEGATED_AUTH_PROVIDER_ID = "openai-codex";
		process.env.PI_DELEGATED_AUTH_RUNTIME_DIR = "/parent/runtime";
		try {
			const env = getSubagentChildProcessEnv(
				{ command: "pi", args: [] },
				{ PI_SUBAGENT_NAME: "child", PI_DELEGATED_AUTH_RUNTIME_DIR: "/child/runtime" },
			);
			assert.equal(env.PI_SUBAGENT_NAME, "child");
			assert.equal(env.PI_DELEGATED_AUTH_RUNTIME_DIR, "/child/runtime");
			assert.equal(env.PI_DELEGATED_AUTH_API_KEY, undefined);
			assert.equal(env.PI_DELEGATED_AUTH_LEASE_ID, undefined);
			assert.equal(env.PI_AGENT_ROUTER_SUBAGENT, undefined);
			assert.equal(env.PI_DELEGATED_AUTH_PROVIDER_ID, undefined);

			const masked = maskInheritedDelegatedAuthEnv({
				PI_SUBAGENT_NAME: "child",
				PI_DELEGATED_AUTH_RUNTIME_DIR: "/child/runtime",
			});
			assert.equal(masked.PI_DELEGATED_AUTH_API_KEY, "");
			assert.equal(masked.PI_AGENT_ROUTER_SUBAGENT, "");
			assert.equal(masked.PI_DELEGATED_AUTH_RUNTIME_DIR, "/child/runtime");
		} finally {
			for (const [key, value] of Object.entries(restore)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("resolves a required broker even when another broker is registered first", async () => {
		await withRegistry(
			[
				{
					id: "other-broker",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => ({
						mode: "self-managed",
						extensionDirs: ["/abs/other"],
						env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/other" },
					}),
				},
				{
					id: "pi-multi-auth",
					capabilities: ["delegated-auth"],
					prepareSubagentAuth: () => ({
						mode: "self-managed",
						extensionDirs: ["/abs/pi-multi-auth"],
						env: { PI_DELEGATED_AUTH_RUNTIME_DIR: "/multi" },
					}),
				},
			],
			async () => {
				const env = await applyDelegatedAuthEnvOverlay(
					{},
					{
						subagentSessionId: "/tmp/child.jsonl",
						required: { brokerId: "pi-multi-auth", mode: "self-managed" },
					},
				);
				assert.equal(env.PI_DELEGATED_AUTH_RUNTIME_DIR, "/multi");
			},
		);
	});

	it("re-prepares env overlay for resume/retry and enforces required broker", async () => {
		await withRegistry(
			[
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
			async () => {
				const env = await applyDelegatedAuthEnvOverlay(
					{
						FOO: "1",
						PI_DELEGATED_AUTH_RUNTIME_DIR: "/spoofed",
					},
					{
						effectiveModel: "openai-codex/gpt-5.6-luna",
						subagentSessionId: "/tmp/child.jsonl",
						required: { brokerId: "pi-multi-auth", mode: "self-managed" },
					},
				);
				assert.equal(env.FOO, "1");
				assert.equal(env.PI_DELEGATED_AUTH_RUNTIME_DIR, "/resume/runtime");
			},
		);

		const globalScope = globalThis as GlobalWithRegistry;
		const previous = globalScope.__piDelegatedAuthBrokerRegistry;
		delete globalScope.__piDelegatedAuthBrokerRegistry;
		try {
			await assert.rejects(
				() =>
					applyDelegatedAuthEnvOverlay(
						{},
						{
							subagentSessionId: "/tmp/child.jsonl",
							required: { brokerId: "pi-multi-auth", mode: "self-managed" },
						},
					),
				/required for this session but did not prepare auth/,
			);
		} finally {
			if (previous) globalScope.__piDelegatedAuthBrokerRegistry = previous;
		}
	});
});
