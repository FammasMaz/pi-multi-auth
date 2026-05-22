import test from "node:test";
import assert from "node:assert/strict";
import { resetOAuthProviders } from "../src/oauth-compat.js";
import { ProviderRegistry } from "../src/provider-registry.js";

test.afterEach(() => {
	resetOAuthProviders();
});

test("provider registry restores approved OAuth providers after OAuth registry resets", async () => {
	resetOAuthProviders();
	const registry = new ProviderRegistry();

	for (const providerId of [
		"qwen",
		"kimi-coding",
		"anthropic",
		"github-copilot",
		"openai-codex",
	] as const) {
		assert.equal(
			registry.getProviderCapabilities(providerId).supportsOAuth,
			true,
			`expected ${providerId} to support OAuth`,
		);
	}

	const availableProviders = new Set(
		registry.listAvailableOAuthProviders().map((provider) => provider.provider),
	);
	assert.equal(availableProviders.has("qwen"), true);
	assert.equal(availableProviders.has("kimi-coding"), true);
	assert.equal(availableProviders.has("anthropic"), true);
	assert.equal(availableProviders.has("github-copilot"), true);
	assert.equal(availableProviders.has("openai-codex"), true);

	const apiKeyProviders = await registry.listAvailableApiKeyProviders();
	assert.equal(apiKeyProviders.some((provider) => provider.provider === "kimi-coding"), true);
});
