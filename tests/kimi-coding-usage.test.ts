import assert from "node:assert/strict";
import test from "node:test";

import { resetOAuthProviders } from "../src/oauth-compat.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { usageProviders } from "../src/usage/providers.js";

test.afterEach(() => {
	resetOAuthProviders();
});

test("usage provider expansion only enables external account state for supported new providers", () => {
	const registry = new ProviderRegistry();

	assert.equal(registry.getProviderCapabilities("kimi-coding").hasExternalAccountState, true);
	assert.equal(registry.getProviderCapabilities("qwen").hasExternalAccountState, false);
});

test("usage provider registry adds kimi-coding without guessing unsupported qwen endpoints", () => {
	const providerIds = new Set(usageProviders.map((provider) => provider.id));

	assert.equal(providerIds.has("kimi-coding"), true);
	assert.equal(providerIds.has("qwen"), false);
});

test("kimi-coding usage provider normalizes the documented usages endpoint", async (t) => {
	const provider = usageProviders.find((entry) => entry.id === "kimi-coding");
	assert.ok(provider?.fetchUsage, "expected kimi-coding usage provider to be registered");

	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let requestedUrl = "";
	let authorizationHeader = "";
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		requestedUrl = String(input);
		authorizationHeader = new Headers(init?.headers).get("Authorization") ?? "";
		return new Response(
			JSON.stringify({
				usage: {
					name: "Weekly quota",
					used: 70,
					limit: 100,
					remaining: 30,
					reset_in: 604_800,
				},
				limits: [
					{
						name: "5-hour window",
						detail: {
							used: 20,
							limit: 50,
							remaining: 30,
							reset_in: 18_000,
						},
						window: {
							duration: 5,
							timeUnit: "HOUR",
						},
					},
					{
						name: "7-day window",
						detail: {
							used: 70,
							limit: 100,
							remaining: 30,
							reset_in: 604_800,
						},
						window: {
							duration: 7,
							timeUnit: "DAY",
						},
					},
				],
			}),
			{
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
	}) as typeof fetch;

	const snapshot = await provider.fetchUsage({
		accessToken: "kimi-access-token",
		credential: {
			request: {
				baseUrl: "https://api.kimi.com/coding/v1/",
			},
		},
	});

	assert.equal(requestedUrl, "https://api.kimi.com/coding/v1/usages");
	assert.equal(authorizationHeader, "Bearer kimi-access-token");
	assert.ok(snapshot);
	assert.equal(snapshot?.provider, "kimi-coding");
	assert.equal(snapshot?.primary?.usedPercent, 40);
	assert.equal(snapshot?.primary?.windowMinutes, 300);
	assert.equal(snapshot?.secondary?.usedPercent, 70);
	assert.equal(snapshot?.secondary?.windowMinutes, 10_080);
	assert.equal(snapshot?.credits, null);
	assert.equal(snapshot?.copilotQuota, null);
});
