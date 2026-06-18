import assert from "node:assert/strict";
import test from "node:test";

import { resetOAuthProviders } from "../src/oauth-compat.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { usageProviders } from "../src/usage/providers.js";

test.afterEach(() => {
	resetOAuthProviders();
});

test("blazeapi usage provider is registered with external account state support", () => {
	const registry = new ProviderRegistry();
	assert.equal(registry.getProviderCapabilities("blazeapi").hasExternalAccountState, true);

	const providerIds = new Set(usageProviders.map((provider) => provider.id));
	assert.equal(providerIds.has("blazeapi"), true);
});

test("blazeapi usage provider parses /api/usage Pro plan into daily request and credit windows", async (t) => {
	const provider = usageProviders.find((entry) => entry.id === "blazeapi");
	const fetchUsage = provider?.fetchUsage;
	assert.ok(fetchUsage, "expected blazeapi usage provider to be registered");

	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let requestedUrl = "";
	let authorizationHeader = "";
	let userAgentHeader = "";
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		requestedUrl = String(input);
		const headers = new Headers(init?.headers);
		authorizationHeader = headers.get("Authorization") ?? "";
		userAgentHeader = headers.get("User-Agent") ?? "";
		// Verified live response shape from GET https://blazeai.boxu.dev/api/usage.
		return new Response(
			JSON.stringify({
				user: { id: "user-uuid", name: "tester", plan: "Pro" },
				plan: {
					name: "Pro",
					daily_requests: 8000,
					rate_limit_rpm: 60,
					premium_daily_credits: 2000,
					expires_at: "2026-06-06T08:41:20.226Z",
				},
				usage: {
					today: {
						requests: 800,
						credits: 18,
						premium_credits: 500,
					},
					total: {
						requests: 1308,
						credits: 3072.4,
					},
				},
				daily_breakdown: [],
				recent_requests: [],
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	}) as typeof fetch;

	const snapshot = await fetchUsage({ accessToken: "blz_test_api_key" });

	assert.equal(requestedUrl, "https://blazeai.boxu.dev/api/usage");
	assert.equal(authorizationHeader, "Bearer blz_test_api_key");
	assert.equal(userAgentHeader, "pi-multi-auth");
	assert.ok(snapshot);
	assert.equal(snapshot?.provider, "blazeapi");
	assert.equal(snapshot?.planType, "Pro");
	assert.equal(snapshot?.primary?.usedPercent, 10);
	assert.equal(snapshot?.primary?.windowMinutes, 24 * 60);
	assert.equal(snapshot?.secondary?.usedPercent, 25);
	assert.equal(snapshot?.secondary?.windowMinutes, 24 * 60);
	assert.equal(snapshot?.credits?.hasCredits, true);
	assert.equal(snapshot?.credits?.unlimited, false);
	assert.equal(snapshot?.credits?.balance, "1500 premium credits left today");
	assert.equal(snapshot?.copilotQuota, null);
	assert.ok(typeof snapshot?.estimatedResetAt === "number");
});

test("blazeapi usage provider parses Free plan with zero premium credits", async (t) => {
	const provider = usageProviders.find((entry) => entry.id === "blazeapi");
	const fetchUsage = provider?.fetchUsage;
	assert.ok(fetchUsage);

	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let requestedUrl = "";
	globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
		requestedUrl = String(input);
		return new Response(
			JSON.stringify({
				user: { id: "user-uuid", name: "netrunner", plan: "Free" },
				plan: {
					name: "Free",
					daily_requests: 1000,
					rate_limit_rpm: 20,
					premium_daily_credits: 0,
					expires_at: null,
				},
				usage: {
					today: { requests: 10, credits: 12, premium_credits: 0 },
					total: { requests: 33, credits: 33 },
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	const snapshot = await fetchUsage({
		accessToken: "blz_free_key",
		credential: {
			// Verifies that an OpenAI-compat-style baseUrl is normalized back to the API root.
			request: { baseUrl: "https://blazeai.boxu.dev/api/v1/chat/completions" },
		},
	});

	assert.equal(requestedUrl, "https://blazeai.boxu.dev/api/usage");
	assert.equal(snapshot?.planType, "Free");
	assert.equal(snapshot?.primary?.usedPercent, 1);
	assert.equal(snapshot?.secondary, null);
	assert.equal(snapshot?.credits?.hasCredits, false);
	assert.equal(snapshot?.credits?.balance, "0 premium credits/day");
});

test("blazeapi usage provider falls back to the legacy /api/account flat shape", async (t) => {
	const provider = usageProviders.find((entry) => entry.id === "blazeapi");
	const fetchUsage = provider?.fetchUsage;
	assert.ok(fetchUsage);

	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	globalThis.fetch = (async (): Promise<Response> => {
		// Legacy HAR-style payload where `usage.today` is a flat request count and
		// `usage.premium_used` lives at the same level.
		return new Response(
			JSON.stringify({
				plan: {
					name: "Pro",
					daily_requests: 8000,
					premium_daily_credits: 2000,
				},
				usage: { today: 800, premium_used: 500 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	const snapshot = await fetchUsage({ accessToken: "blz_legacy" });
	assert.equal(snapshot?.primary?.usedPercent, 10);
	assert.equal(snapshot?.secondary?.usedPercent, 25);
	assert.equal(snapshot?.credits?.balance, "1500 premium credits left today");
});

test("blazeapi usage provider surfaces 401 as a token expiration error", async (t) => {
	const provider = usageProviders.find((entry) => entry.id === "blazeapi");
	const fetchUsage = provider?.fetchUsage;
	assert.ok(fetchUsage);

	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	globalThis.fetch = (async (): Promise<Response> => {
		return new Response(
			JSON.stringify({ error: { message: "Login required.", code: "auth_required" } }),
			{ status: 401, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	await assert.rejects(
		() => fetchUsage({ accessToken: "blz_expired" }),
		/token expired or invalid/i,
	);
});

test("blazeapi usage provider throws when plan limits are missing", async (t) => {
	const provider = usageProviders.find((entry) => entry.id === "blazeapi");
	const fetchUsage = provider?.fetchUsage;
	assert.ok(fetchUsage);

	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	globalThis.fetch = (async (): Promise<Response> => {
		return new Response(JSON.stringify({ user: { name: "x" }, plan: {}, usage: {} }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	await assert.rejects(
		() => fetchUsage({ accessToken: "blz_anything" }),
		/did not include plan limits/i,
	);
});
