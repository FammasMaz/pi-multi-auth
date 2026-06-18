import type { Api } from "@earendil-works/pi-ai";
import { isRecord } from "./auth-error-utils.js";
import type { AuthWriter } from "./auth-writer.js";
import { isCloudflareWorkersAiProvider } from "./cloudflare-provider.js";
import {
	isValidCloudflareOpenAIBaseUrl,
	resolveCloudflareWorkersAiBaseUrlFromCredential,
} from "./credential-request-overrides.js";
import type { ProviderModelDefinition, ProviderRegistrationMetadata, SupportedProviderId } from "./types.js";

/** Default Workers AI OpenAI-compat reasoning map (API accepts low/medium/high/max). */
export const CLOUDFLARE_WORKERS_AI_REASONING_EFFORT_MAP: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
};

export const CLOUDFLARE_WORKERS_AI_PROVIDER_COMPAT: Record<string, unknown> = {
	supportsReasoningEffort: true,
	reasoningEffortMap: { ...CLOUDFLARE_WORKERS_AI_REASONING_EFFORT_MAP },
};

const GLM_52_MODEL_ID = "@cf/zai-org/glm-5.2";

function buildDefaultGlm52Model(): ProviderModelDefinition {
	return {
		id: GLM_52_MODEL_ID,
		name: "GLM 5.2 (Workers AI)",
		api: "openai-completions" as Api,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "max",
		},
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
		compat: { ...CLOUDFLARE_WORKERS_AI_PROVIDER_COMPAT },
	};
}

async function resolveCloudflareBaseUrlFromAuth(
	authWriter: AuthWriter,
	provider: SupportedProviderId,
): Promise<string | null> {
	const entries = await authWriter.getProviderCredentialEntries(provider);
	for (const entry of entries) {
		const fromRequest = entry.credential.request?.baseUrl;
		if (typeof fromRequest === "string" && isValidCloudflareOpenAIBaseUrl(fromRequest)) {
			return fromRequest.replace(/\/$/, "");
		}
		const fromEnv = resolveCloudflareWorkersAiBaseUrlFromCredential(entry.credential);
		if (fromEnv) {
			return fromEnv;
		}
	}
	return null;
}

/**
 * Supplies Workers AI model metadata when models.json / pi-ai built-ins are absent
 * (typical for credential-only Cloudflare setups).
 */
export async function enrichCloudflareWorkersAiRegistrationMetadata(
	provider: SupportedProviderId,
	metadata: ProviderRegistrationMetadata | null,
	authWriter: AuthWriter,
): Promise<ProviderRegistrationMetadata | null> {
	if (!isCloudflareWorkersAiProvider(provider)) {
		return metadata;
	}
	if (metadata && metadata.models.length > 0) {
		const models = metadata.models.map((model) => ({
			...model,
			reasoning: model.reasoning || model.id === GLM_52_MODEL_ID,
			compat: {
				...CLOUDFLARE_WORKERS_AI_PROVIDER_COMPAT,
				...(model.compat ?? {}),
				reasoningEffortMap: {
					...CLOUDFLARE_WORKERS_AI_REASONING_EFFORT_MAP,
					...(isRecord(model.compat?.reasoningEffortMap) ? model.compat.reasoningEffortMap : {}),
				},
			},
		}));
		return { ...metadata, models };
	}

	const baseUrl = await resolveCloudflareBaseUrlFromAuth(authWriter, provider);
	if (!baseUrl) {
		return metadata;
	}

	const model = {
		...buildDefaultGlm52Model(),
		baseUrl,
	};

	return {
		provider,
		api: "openai-completions" as Api,
		apis: ["openai-completions" as Api],
		baseUrl,
		models: [model],
	};
}