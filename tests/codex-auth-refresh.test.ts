import assert from "node:assert/strict";
import test from "node:test";

import { refreshOAuthCredential } from "../src/oauth-compat.js";

function encodeBase64Url(value: string): string {
	return Buffer.from(value, "utf8")
		.toString("base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function createJwt(payload: Record<string, unknown>): string {
	return [
		encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
		encodeBase64Url(JSON.stringify(payload)),
		"signature",
	].join(".");
}

test("OpenAI Codex refresh uses codex-lb JSON payload and stores id token metadata", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const accessToken = createJwt({
		exp: Math.floor(Date.now() / 1000) + 3600,
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct_codex_test",
		},
	});
	const idToken = createJwt({
		email: "codex@example.test",
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct_codex_test",
		},
	});
	let requestBody: unknown;
	let contentType: string | null = null;

	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		contentType = new Headers(init?.headers).get("Content-Type");
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				access_token: accessToken,
				refresh_token: "next-refresh-token",
				id_token: idToken,
				expires_in: 3600,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	const refreshed = await refreshOAuthCredential("openai-codex", {
		access: "old-access-token",
		refresh: "old-refresh-token",
		expires: 1,
	});

	assert.equal(contentType, "application/json");
	assert.deepEqual(requestBody, {
		grant_type: "refresh_token",
		client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
		refresh_token: "old-refresh-token",
		scope: "openid profile email",
	});
	assert.equal(refreshed.access, accessToken);
	assert.equal(refreshed.refresh, "next-refresh-token");
	assert.equal(refreshed.idToken, idToken);
	assert.equal(refreshed.id_token, idToken);
	assert.equal(refreshed.accountId, "acct_codex_test");
	assert.equal(typeof refreshed.lastRefreshAt, "number");
	assert.equal(typeof refreshed.last_refresh, "string");
});
