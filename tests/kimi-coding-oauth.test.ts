import test from "node:test";
import assert from "node:assert/strict";
import {
	createKimiCodingOAuthProvider,
	registerKimiCodingOAuthProvider,
} from "../src/oauth-kimi-coding.js";
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

test("registerKimiCodingOAuthProvider exposes a Kimi Coding OAuth provider", () => {
	registerKimiCodingOAuthProvider();
	const provider = getOAuthProvider("kimi-coding");

	assert.ok(provider, "expected Kimi Coding OAuth provider to be registered");
	assert.equal(provider?.id, "kimi-coding");
	assert.equal(provider?.name, "Kimi For Coding");
	assert.equal(provider?.usesCallbackServer, false);
	assert.equal(provider?.getApiKey({ access: "kimi-token", refresh: "refresh", expires: 1 }), "kimi-token");
});

test("createKimiCodingOAuthProvider completes device authorization", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let now = 1_700_000_000_000;
	let pollCount = 0;
	const provider = createKimiCodingOAuthProvider({
		deviceCodeUrl: "https://auth.kimi.example.test/device_authorization",
		tokenUrl: "https://auth.kimi.example.test/token",
		clientId: "kimi-public-client",
		pollIntervalMs: 1,
		requestTimeoutMs: 1_000,
		now: () => now,
		sleep: async () => {
			now += 1_000;
		},
		fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === "https://auth.kimi.example.test/device_authorization") {
				return new Response(
					JSON.stringify({
						device_code: "kimi-device-code",
						user_code: "KIMI-1234",
						verification_uri: "https://www.kimi.com/code/authorize_device",
						expires_in: 120,
						interval: 1,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://auth.kimi.example.test/token") {
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
						access_token: "kimi-access-token",
						refresh_token: "kimi-refresh-token",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		},
	});

	const callbacks = createLoginCallbacks();
	const credentials = await provider.login(callbacks);

	assert.deepEqual(callbacks.authCalls, [
		{ url: "https://www.kimi.com/code/authorize_device?user_code=KIMI-1234" },
	]);
	assert.match(callbacks.progressMessages.join("\n"), /successful/i);
	assert.equal(credentials.access, "kimi-access-token");
	assert.equal(credentials.refresh, "kimi-refresh-token");
	assert.equal(credentials.provider, "kimi-coding");
	assert.equal(credentials.expires, now + 3_600_000);
	assert.equal(provider.getApiKey(credentials), "kimi-access-token");

	const deviceCodeBody = new URLSearchParams(String(requests[0]?.init?.body ?? ""));
	assert.equal(requests[0]?.init?.method, "POST");
	assert.equal(deviceCodeBody.get("client_id"), "kimi-public-client");

	const tokenBody = new URLSearchParams(String(requests[1]?.init?.body ?? ""));
	assert.equal(requests[1]?.init?.method, "POST");
	assert.equal(tokenBody.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
	assert.equal(tokenBody.get("client_id"), "kimi-public-client");
	assert.equal(tokenBody.get("device_code"), "kimi-device-code");
});

test("createKimiCodingOAuthProvider refreshes stored OAuth credentials", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	let now = 1_700_000_100_000;
	const provider = createKimiCodingOAuthProvider({
		tokenUrl: "https://auth.kimi.example.test/token",
		clientId: "kimi-public-client",
		now: () => now,
		fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			return new Response(
				JSON.stringify({
					access_token: "next-access-token",
					refresh_token: "next-refresh-token",
					expires_in: 7200,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	});

	const refreshed = await provider.refreshToken({
		access: "old-access-token",
		refresh: "old-refresh-token",
		expires: now - 1_000,
		provider: "kimi-coding",
	});

	assert.equal(refreshed.access, "next-access-token");
	assert.equal(refreshed.refresh, "next-refresh-token");
	assert.equal(refreshed.expires, now + 7_200_000);

	const refreshBody = new URLSearchParams(String(requests[0]?.init?.body ?? ""));
	assert.equal(refreshBody.get("grant_type"), "refresh_token");
	assert.equal(refreshBody.get("refresh_token"), "old-refresh-token");
	assert.equal(refreshBody.get("client_id"), "kimi-public-client");

	await assert.rejects(
		() =>
			provider.refreshToken({
				access: "missing-refresh",
				refresh: "",
				expires: now - 1,
				provider: "kimi-coding",
			}),
		(error: unknown) =>
			error instanceof OAuthRefreshFailureError &&
			error.details.providerId === "kimi-coding" &&
			error.details.reason === "missing_refresh_token",
	);
});
