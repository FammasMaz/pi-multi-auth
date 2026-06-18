import assert from "node:assert/strict";
import test from "node:test";
import {
	CLOUDFLARE_WORKERS_AI_REASONING_EFFORT_MAP,
	enrichCloudflareWorkersAiRegistrationMetadata,
} from "../src/cloudflare-workers-ai-models.js";
import type { AuthWriter } from "../src/auth-writer.js";

test("reasoning effort map includes xhigh to max", () => {
	assert.equal(CLOUDFLARE_WORKERS_AI_REASONING_EFFORT_MAP.xhigh, "max");
	assert.equal(CLOUDFLARE_WORKERS_AI_REASONING_EFFORT_MAP.high, "high");
});

test("enrichCloudflareWorkersAiRegistrationMetadata builds GLM 5.2 from credential env", async () => {
	const authWriter = {
		async getProviderCredentialEntries() {
			return [
				{
					credentialId: "cloudflare-workers-ai",
					credential: {
						type: "api_key" as const,
						key: "cfut_test",
						env: { CLOUDFLARE_ACCOUNT_ID: "f375c92e4928eedf49cb43a1273f4897" },
					},
				},
			];
		},
	} as unknown as AuthWriter;

	const metadata = await enrichCloudflareWorkersAiRegistrationMetadata(
		"cloudflare-workers-ai",
		null,
		authWriter,
	);
	assert.ok(metadata);
	const model = metadata!.models.find((m) => m.id === "@cf/zai-org/glm-5.2");
	assert.ok(model);
	assert.equal(model!.reasoning, true);
	assert.equal(model!.thinkingLevelMap?.xhigh, "max");
	const compat = model!.compat as { reasoningEffortMap?: Record<string, string> };
	assert.equal(compat.reasoningEffortMap?.xhigh, "max");
	assert.match(model!.baseUrl ?? "", /f375c92e4928eedf49cb43a1273f4897/);
});