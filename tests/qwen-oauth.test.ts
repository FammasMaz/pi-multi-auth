import test from "node:test";
import assert from "node:assert/strict";
import {
	createQwenOAuthProvider,
	registerQwenOAuthProvider,
} from "../src/oauth-qwen.js";
import {
	getOAuthProvider,
	resetOAuthProviders,
} from "../src/oauth-compat.js";
import { OAuthRefreshFailureError } from "../src/types-oauth.js";
import type { OAuthLoginCallbacks } from "../src/oauth-compat.js";

function createLoginCallbacks(): OAuthLoginCallbacks & {
	authCalls: Array<{ url: string; instructions?: string }>;
	progressMessages: string[];
} {
	const authCalls: Array<{ url: string; instructions?: string }> = [];
	const progressMessages: string[] = [];
	return {
		authCalls,
		progressMessages,
		onAuth: (info) => {
			authCalls.push(info);
		},
		onPrompt: async () => "",
		onDeviceCode: () => {},
		onSelect: async () => undefined,
		onProgress: (message) => {
			progressMessages.push(message);
		},
	};
}

test.afterEach(() => {
	resetOAuthProviders();
});

test("registerQwenOAuthProvider exposes a Qwen OAuth provider", () => {
	registerQwenOAuthProvider();
	const provider = getOAuthProvider("qwen");

	assert.ok(provider, "expected Qwen OAuth provider to be registered");
	assert.equal(provider?.id, "qwen");
	assert.equal(provider?.name, "Qwen");
	assert.equal(provider?.usesCallbackServer, false);
	assert.equal(provider?.getApiKey({ access: "qwen-token", refresh: "refresh", expires: 1 }), "qwen-token");
});

test("createQwenOAuthProvider completes device authorization with PKCE", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let now = 1_700_000_000_000;
	let pollCount = 0;
	const provider = createQwenOAuthProvider({
		deviceCodeUrl: "https://chat.qwen.example.test/device/code",
		tokenUrl: "https://chat.qwen.example.test/token",
		clientId: "qwen-public-client",
		scope: "openid profile email model.completion",
		defaultBaseUrl: "https://dashscope.aliyun.test/compatible-mode/v1",
		pollIntervalMs: 1,
		requestTimeoutMs: 1_000,
		now: () => now,
		sleep: async () => {
			now += 1_000;
		},
		generatePkcePair: async () => ({
			verifier: "qwen-verifier",
			challenge: "qwen-challenge",
		}),
		fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === "https://chat.qwen.example.test/device/code") {
				return new Response(
					JSON.stringify({
						device_code: "device-code-123",
						user_code: "QWEN-1234",
						verification_uri: "https://chat.qwen.example.test/activate",
						verification_uri_complete:
							"https://chat.qwen.example.test/activate?user_code=QWEN-1234",
						expires_in: 120,
						interval: 1,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://chat.qwen.example.test/token") {
				pollCount += 1;
				if (pollCount === 1) {
					return new Response(
						JSON.stringify({
							error: "authorization_pending",
							error_description: "waiting for approval",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						access_token: "qwen-access-token",
						refresh_token: "qwen-refresh-token",
						expires_in: 3600,
						resource_url: "portal.qwen.ai",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		},
	});

	const callbacks = createLoginCallbacks();
	const credentials = await provider.login(callbacks);
	const requestConfig = credentials as { request?: { baseUrl?: string } };

	assert.deepEqual(callbacks.authCalls, [
		{ url: "https://chat.qwen.example.test/activate?user_code=QWEN-1234" },
	]);
	assert.match(callbacks.progressMessages.join("\n"), /successful/i);
	assert.equal(credentials.access, "qwen-access-token");
	assert.equal(credentials.refresh, "qwen-refresh-token");
	assert.equal(credentials.provider, "qwen");
	assert.equal(credentials.expires, now + 3_600_000);
	assert.equal(requestConfig.request?.baseUrl, "https://portal.qwen.ai/v1");
	assert.equal(provider.getApiKey(credentials), "qwen-access-token");

	const deviceCodeBody = new URLSearchParams(String(requests[0]?.init?.body ?? ""));
	assert.equal(requests[0]?.init?.method, "POST");
	assert.equal(deviceCodeBody.get("client_id"), "qwen-public-client");
	assert.equal(deviceCodeBody.get("scope"), "openid profile email model.completion");
	assert.equal(deviceCodeBody.get("code_challenge"), "qwen-challenge");
	assert.equal(deviceCodeBody.get("code_challenge_method"), "S256");

	const tokenBody = new URLSearchParams(String(requests[1]?.init?.body ?? ""));
	assert.equal(requests[1]?.init?.method, "POST");
	assert.equal(tokenBody.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
	assert.equal(tokenBody.get("client_id"), "qwen-public-client");
	assert.equal(tokenBody.get("device_code"), "device-code-123");
	assert.equal(tokenBody.get("code_verifier"), "qwen-verifier");
});

test("createQwenOAuthProvider refreshes stored OAuth credentials", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let now = 1_700_000_100_000;
	const provider = createQwenOAuthProvider({
		tokenUrl: "https://chat.qwen.example.test/token",
		clientId: "qwen-public-client",
		now: () => now,
		fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			return new Response(
				JSON.stringify({
					access_token: "next-access-token",
					refresh_token: "next-refresh-token",
					expires_in: 7200,
					resource_url: "https://portal.qwen.ai",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	});

	const refreshed = await provider.refreshToken({
		access: "old-access-token",
		refresh: "old-refresh-token",
		expires: now - 1_000,
		provider: "qwen",
	});
	const requestConfig = refreshed as { request?: { baseUrl?: string } };

	assert.equal(refreshed.access, "next-access-token");
	assert.equal(refreshed.refresh, "next-refresh-token");
	assert.equal(refreshed.expires, now + 7_200_000);
	assert.equal(requestConfig.request?.baseUrl, "https://portal.qwen.ai/v1");

	const refreshBody = new URLSearchParams(String(requests[0]?.init?.body ?? ""));
	assert.equal(refreshBody.get("grant_type"), "refresh_token");
	assert.equal(refreshBody.get("refresh_token"), "old-refresh-token");
	assert.equal(refreshBody.get("client_id"), "qwen-public-client");

	await assert.rejects(
		() =>
			provider.refreshToken({
				access: "missing-refresh",
				refresh: "",
				expires: now - 1,
				provider: "qwen",
			}),
		(error: unknown) =>
			error instanceof OAuthRefreshFailureError &&
			error.details.providerId === "qwen" &&
			error.details.reason === "missing_refresh_token",
	);
});
