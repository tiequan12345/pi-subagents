import { isAbsolute } from "node:path";

export type DelegatedAuthPrepareRequest = {
	providerId?: string;
	modelId?: string;
	modelRef?: string;
	api?: string;
	parentSessionId?: string;
	subagentSessionId: string;
};

type DelegatedAuthPrepareResult =
	| {
			mode: "self-managed";
			extensionDirs: string[];
			env?: Record<string, string>;
	  }
	| {
			mode: "lease";
			env: Record<string, string>;
			leaseId: string;
	  }
	| {
			mode: "none";
			env?: Record<string, string>;
			extensionDirs?: string[];
	  };

type DelegatedAuthBroker = {
	id: string;
	capabilities: readonly string[];
	prepareSubagentAuth: (
		request: DelegatedAuthPrepareRequest,
	) => Promise<DelegatedAuthPrepareResult> | DelegatedAuthPrepareResult;
};

type DelegatedAuthBrokerRegistry = {
	list: () => DelegatedAuthBroker[];
};

export type DelegatedAuthLaunchOverlay = {
	brokerId: string;
	mode: "self-managed";
	extensionDirs: string[];
	env: Record<string, string>;
};

export type DelegatedAuthRequirement = {
	brokerId: string;
	mode: "self-managed";
};

export type DelegatedAuthExtensionPlan = {
	effectiveExtensions: string[] | undefined;
	requiredExtensions: string[];
};

type GlobalWithDelegatedAuthBrokerRegistry = typeof globalThis & {
	__piDelegatedAuthBrokerRegistry?: DelegatedAuthBrokerRegistry;
};

/** Known delegated-auth env keys that must not inherit from a parent process. */
export const DELEGATED_AUTH_ENV_KEYS = [
	"PI_AGENT_ROUTER_SUBAGENT",
	"PI_DELEGATED_AUTH_PROVIDER_ID",
	"PI_DELEGATED_AUTH_LEASE_ID",
	"PI_DELEGATED_AUTH_API_KEY",
	"PI_DELEGATED_AUTH_RUNTIME_DIR",
] as const;

const RESERVED_DELEGATED_AUTH_ENV =
	/^(?:PI_DELEGATED_AUTH_.*|PI_AGENT_ROUTER_SUBAGENT)$/;

export function splitProviderModel(effectiveModel?: string): {
	providerId?: string;
	modelId?: string;
} {
	const normalized = effectiveModel?.trim();
	if (!normalized) return {};
	const slash = normalized.indexOf("/");
	if (slash <= 0 || slash === normalized.length - 1) {
		return { modelId: normalized };
	}
	return {
		providerId: normalized.slice(0, slash),
		modelId: normalized.slice(slash + 1),
	};
}

function getRegistry(): DelegatedAuthBrokerRegistry | undefined {
	const registry = (globalThis as GlobalWithDelegatedAuthBrokerRegistry)
		.__piDelegatedAuthBrokerRegistry;
	if (!registry || typeof registry.list !== "function") return undefined;
	return registry;
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Delegated auth ${label} must be a non-empty string`);
	}
	return value.trim();
}

function validateSelfManagedResult(
	brokerId: string,
	result: Extract<DelegatedAuthPrepareResult, { mode: "self-managed" }>,
): DelegatedAuthLaunchOverlay {
	if (!Array.isArray(result.extensionDirs)) {
		throw new Error(
			`Delegated auth broker "${brokerId}" self-managed result missing extensionDirs`,
		);
	}
	const extensionDirs = result.extensionDirs.map((dir, index) => {
		const path = requireNonEmptyString(dir, `extensionDirs[${index}]`);
		if (!isAbsolute(path)) {
			throw new Error(
				`Delegated auth broker "${brokerId}" extensionDirs[${index}] must be an absolute path`,
			);
		}
		return path;
	});
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(result.env ?? {})) {
		env[requireNonEmptyString(key, "env key")] = requireNonEmptyString(
			value,
			`env.${key}`,
		);
	}
	return {
		brokerId,
		mode: "self-managed",
		extensionDirs,
		env,
	};
}

export async function resolveDelegatedAuthOverlay(
	request: DelegatedAuthPrepareRequest,
	options?: { requiredBrokerId?: string },
): Promise<DelegatedAuthLaunchOverlay | undefined> {
	const registry = getRegistry();
	if (!registry) return undefined;

	const brokers = registry
		.list()
		.filter(
			(broker) =>
				typeof broker?.id === "string" &&
				broker.id.trim().length > 0 &&
				Array.isArray(broker.capabilities) &&
				broker.capabilities.includes("delegated-auth") &&
				typeof broker.prepareSubagentAuth === "function",
		);
	const requiredBrokerId = options?.requiredBrokerId?.trim();
	const candidates = requiredBrokerId
		? brokers.filter((broker) => broker.id.trim() === requiredBrokerId)
		: brokers;

	for (const broker of candidates) {
		const result = await broker.prepareSubagentAuth(request);
		if (result == null || typeof result !== "object") {
			throw new Error(
				`Delegated auth broker "${broker.id}" returned invalid result`,
			);
		}
		const mode = (result as { mode?: unknown }).mode;
		switch (mode) {
			case "none":
				continue;
			case "lease":
				throw new Error(
					`Delegated auth broker "${broker.id}" returned unsupported mode "lease"`,
				);
			case "self-managed":
				return validateSelfManagedResult(
					broker.id.trim(),
					result as Extract<DelegatedAuthPrepareResult, { mode: "self-managed" }>,
				);
			default:
				throw new Error(
					`Delegated auth broker "${broker.id}" returned unsupported mode ${JSON.stringify(mode)}`,
				);
		}
	}
	return undefined;
}

export function buildDelegatedAuthRequest(options: {
	effectiveModel?: string;
	effectiveModelRef?: string;
	parentSessionId?: string;
	subagentSessionId: string;
}): DelegatedAuthPrepareRequest {
	const { providerId, modelId } = splitProviderModel(options.effectiveModel);
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(options.effectiveModelRef
			? { modelRef: options.effectiveModelRef }
			: {}),
		...(options.parentSessionId
			? { parentSessionId: options.parentSessionId }
			: {}),
		subagentSessionId: options.subagentSessionId,
	};
}

/**
 * Explicit allowlists absorb broker dirs into the list.
 * Default ("all") keeps extensions undefined and tracks dirs as required -e extras.
 */
export function applyDelegatedAuthExtensions(
	effectiveExtensions: string[] | undefined,
	extensionDirs: string[],
): DelegatedAuthExtensionPlan {
	if (extensionDirs.length === 0) {
		return { effectiveExtensions, requiredExtensions: [] };
	}
	if (effectiveExtensions === undefined) {
		return {
			effectiveExtensions: undefined,
			requiredExtensions: [...extensionDirs],
		};
	}
	const next = [...effectiveExtensions];
	for (const dir of extensionDirs) {
		if (!next.includes(dir)) next.push(dir);
	}
	return {
		effectiveExtensions: next,
		requiredExtensions: [...extensionDirs],
	};
}

/** Drop frontmatter/process spoofing of delegated-auth internals. */
export function stripReservedDelegatedAuthEnv<T extends Record<string, string | undefined>>(
	env: T,
): T {
	for (const key of Object.keys(env)) {
		if (RESERVED_DELEGATED_AUTH_ENV.test(key)) delete env[key];
	}
	return env;
}

/**
 * For shell-prefix launches: force-clear reserved keys not set by the overlay so
 * the child does not inherit parent lease/runtime values from the ambient shell.
 */
export function maskInheritedDelegatedAuthEnv(
	overlay: Record<string, string>,
): Record<string, string> {
	const env = { ...overlay };
	for (const key of DELEGATED_AUTH_ENV_KEYS) {
		if (!(key in env)) env[key] = "";
	}
	return env;
}

export function mergeDelegatedAuthEnv(
	env: Record<string, string>,
	overlay: DelegatedAuthLaunchOverlay | undefined,
): Record<string, string> {
	if (!overlay) return env;
	Object.assign(env, overlay.env);
	return env;
}

/** Re-prepare overlay env for resume/retry. Never persists; call per spawn. */
export async function applyDelegatedAuthEnvOverlay(
	env: Record<string, string>,
	options: {
		effectiveModel?: string;
		effectiveModelRef?: string;
		parentSessionId?: string;
		subagentSessionId: string;
		required?: DelegatedAuthRequirement;
	},
): Promise<Record<string, string>> {
	stripReservedDelegatedAuthEnv(env);
	const overlay = await resolveDelegatedAuthOverlay(
		buildDelegatedAuthRequest(options),
		options.required
			? { requiredBrokerId: options.required.brokerId }
			: undefined,
	);
	if (options.required && !overlay) {
		throw new Error(
			`Delegated auth broker "${options.required.brokerId}" is required for this session but did not prepare auth`,
		);
	}
	return mergeDelegatedAuthEnv(env, overlay);
}
