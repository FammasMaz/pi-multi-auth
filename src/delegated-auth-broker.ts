import type { AccountManager } from "./account-manager.js";
import { EXTENSION_ROOT } from "./config.js";
import { multiAuthDebugLogger } from "./debug-logger.js";
import {
	PI_DELEGATED_AUTH_RUNTIME_DIR_ENV,
	getAgentRuntimeRoot,
} from "./runtime-paths.js";

type DelegatedAuthPrepareRequest = {
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
	release?: (request: {
		leaseId?: string;
		parentSessionId?: string;
		subagentSessionId: string;
		providerId?: string;
	}) => Promise<void> | void;
	reportAttemptResult?: (result: {
		providerId?: string;
		modelId?: string;
		modelRef?: string;
		api?: string;
		parentSessionId?: string;
		subagentSessionId: string;
		mode: DelegatedAuthPrepareResult["mode"];
		leaseId?: string;
		exitCode: number;
		timedOut: boolean;
		stderr?: string;
	}) => Promise<void> | void;
};

type DelegatedAuthBrokerRegistry = {
	register: (broker: DelegatedAuthBroker) => void;
	unregister: (brokerId: string) => void;
	list: () => DelegatedAuthBroker[];
	get: (brokerId: string) => DelegatedAuthBroker | undefined;
};

type GlobalWithDelegatedAuthBrokerRegistry = typeof globalThis & {
	__piDelegatedAuthBrokerRegistry?: DelegatedAuthBrokerRegistry;
};

const BROKER_ID = "pi-multi-auth";

function normalizeProviderId(providerId: string | undefined): string | undefined {
	const normalized = providerId?.trim().toLowerCase();
	return normalized || undefined;
}

function getOrCreateDelegatedAuthBrokerRegistry(): DelegatedAuthBrokerRegistry {
	const globalScope = globalThis as GlobalWithDelegatedAuthBrokerRegistry;
	if (globalScope.__piDelegatedAuthBrokerRegistry) {
		return globalScope.__piDelegatedAuthBrokerRegistry;
	}

	const brokers = new Map<string, DelegatedAuthBroker>();
	const registry: DelegatedAuthBrokerRegistry = {
		register: (broker) => {
			if (
				typeof broker.id !== "string" ||
				broker.id.trim().length === 0 ||
				!Array.isArray(broker.capabilities) ||
				!broker.capabilities.includes("delegated-auth") ||
				typeof broker.prepareSubagentAuth !== "function"
			) {
				return;
			}
			brokers.set(broker.id.trim(), broker);
		},
		unregister: (brokerId) => {
			brokers.delete(brokerId.trim());
		},
		list: () => [...brokers.values()],
		get: (brokerId) => brokers.get(brokerId.trim()),
	};

	globalScope.__piDelegatedAuthBrokerRegistry = registry;
	return registry;
}

export function registerDelegatedAuthBroker(
	accountManager: AccountManager,
): DelegatedAuthBroker {
	const broker: DelegatedAuthBroker = {
		id: BROKER_ID,
		capabilities: ["delegated-auth"],
		prepareSubagentAuth: async (request) => {
			const providerId = normalizeProviderId(request.providerId);
			if (!providerId) {
				return { mode: "none" };
			}

			const hiddenProviders = new Set(await accountManager.getHiddenProviders());
			if (hiddenProviders.has(providerId)) {
				return { mode: "none" };
			}

			multiAuthDebugLogger.log("delegated_auth_self_managed", {
				provider: providerId,
				modelId: request.modelId,
				modelRef: request.modelRef,
				api: request.api,
				parentSessionId: request.parentSessionId,
				subagentSessionId: request.subagentSessionId,
			});

			return {
				mode: "self-managed",
				extensionDirs: [EXTENSION_ROOT],
				env: {
					[PI_DELEGATED_AUTH_RUNTIME_DIR_ENV]: getAgentRuntimeRoot(),
				},
			};
		},
		release: ({ parentSessionId, subagentSessionId, providerId }) => {
			const keyDistributor = accountManager.getKeyDistributor();
			if (subagentSessionId) {
				keyDistributor.releaseFromSubagent(subagentSessionId);
			}
			if (parentSessionId) {
				keyDistributor.releaseLightweightSessionLeases?.(parentSessionId, providerId);
			}
		},
		reportAttemptResult: (result) => {
			multiAuthDebugLogger.log("delegated_auth_attempt_result", {
				provider: result.providerId,
				modelId: result.modelId,
				modelRef: result.modelRef,
				api: result.api,
				parentSessionId: result.parentSessionId,
				subagentSessionId: result.subagentSessionId,
				mode: result.mode,
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				hasStderr: Boolean(result.stderr?.trim()),
			});
		},
	};

	getOrCreateDelegatedAuthBrokerRegistry().register(broker);
	return broker;
}

export function unregisterDelegatedAuthBroker(broker?: DelegatedAuthBroker): void {
	const registry = (globalThis as GlobalWithDelegatedAuthBrokerRegistry).__piDelegatedAuthBrokerRegistry;
	if (!registry) {
		return;
	}
	registry.unregister(broker?.id ?? BROKER_ID);
}
