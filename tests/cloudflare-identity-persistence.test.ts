import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountManager } from "../src/account-manager.js";
import { AuthWriter } from "../src/auth-writer.js";
import { DEFAULT_MULTI_AUTH_CONFIG } from "../src/config.js";
import { buildMissingUsageDetailLines } from "../src/commands.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { MultiAuthStorage } from "../src/storage.js";
import { UsageService } from "../src/usage/index.js";

function createJsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

test("Cloudflare API-key add persists resolved email as provider friendly name", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-cloudflare-identity-"));
	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const originalFetch = globalThis.fetch;
	const requestedUrls: string[] = [];

	await writeFile(authPath, JSON.stringify({}, null, 2), "utf-8");
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const accountManager = new AccountManager(
		new AuthWriter(authPath),
		new MultiAuthStorage(storagePath),
		new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false }),
		new ProviderRegistry(new AuthWriter(authPath), modelsPath, ["cloudflare"]),
		undefined,
		DEFAULT_MULTI_AUTH_CONFIG,
	);

	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = input.toString();
		requestedUrls.push(url);
		if (url.endsWith("/user")) {
			return createJsonResponse({ success: true, result: { id: "user-1", email: "owner@example.com" } });
		}
		if (url.endsWith("/user/billing/profile")) {
			return createJsonResponse({ success: true, result: {} });
		}
		if (url.endsWith("/accounts/account-1")) {
			return createJsonResponse({ success: true, result: { id: "account-1", name: "Cloudflare Account" } });
		}
		return createJsonResponse({ success: false, errors: [{ message: `Unexpected URL ${url}` }] }, { status: 404 });
	}) as typeof fetch;

	try {
		await accountManager.addApiKeyCredential("cloudflare", "cf-test-token", {
			request: {
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1",
			},
		});

		const stored = (await new MultiAuthStorage(storagePath).read()) as {
			providers?: Record<string, { friendlyNames?: Record<string, string> }>;
		};

		assert.equal(stored.providers?.cloudflare?.friendlyNames?.cloudflare, "owner@example.com");
		assert.deepEqual(requestedUrls.sort(), [
			"https://api.cloudflare.com/client/v4/accounts/account-1",
			"https://api.cloudflare.com/client/v4/user",
			"https://api.cloudflare.com/client/v4/user/billing/profile",
		]);
	} finally {
		globalThis.fetch = originalFetch;
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("Cloudflare credential identity refresh persists refreshed email as provider friendly name", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-cloudflare-refresh-identity-"));
	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const originalFetch = globalThis.fetch;
	let userLookupCount = 0;

	await writeFile(authPath, JSON.stringify({}, null, 2), "utf-8");
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const accountManager = new AccountManager(
		new AuthWriter(authPath),
		new MultiAuthStorage(storagePath),
		new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false }),
		new ProviderRegistry(new AuthWriter(authPath), modelsPath, ["cloudflare"]),
		undefined,
		DEFAULT_MULTI_AUTH_CONFIG,
	);

	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = input.toString();
		if (url.endsWith("/user")) {
			userLookupCount += 1;
			return createJsonResponse({
				success: true,
				result: {
					id: "user-1",
					email: userLookupCount === 1 ? "owner@example.com" : "refreshed@example.com",
				},
			});
		}
		if (url.endsWith("/user/billing/profile")) {
			return createJsonResponse({ success: true, result: {} });
		}
		if (url.endsWith("/accounts/account-1")) {
			return createJsonResponse({ success: true, result: { id: "account-1", name: "Cloudflare Account" } });
		}
		return createJsonResponse({ success: false, errors: [{ message: `Unexpected URL ${url}` }] }, { status: 404 });
	}) as typeof fetch;

	try {
		await accountManager.addApiKeyCredential("cloudflare", "cf-test-token", {
			request: {
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1",
			},
		});
		await accountManager.setFriendlyName("cloudflare", "cloudflare", "stale@example.com");

		const result = await accountManager.refreshCloudflareCredentialIdentity("cloudflare", "cloudflare");
		const stored = (await new MultiAuthStorage(storagePath).read()) as {
			providers?: Record<string, { friendlyNames?: Record<string, string> }>;
		};

		assert.equal(result.status, "updated");
		assert.equal(result.friendlyName, "refreshed@example.com");
		assert.equal(stored.providers?.cloudflare?.friendlyNames?.cloudflare, "refreshed@example.com");
		assert.equal(userLookupCount, 2);
	} finally {
		globalThis.fetch = originalFetch;
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("missing usage detail points to cached-data refresh instead of perpetual loading", () => {
	const lines = buildMissingUsageDetailLines(80);
	const rendered = lines.join("\n");

	assert.match(rendered, /No cached usage data/);
	assert.match(rendered, /\[T\]/);
	assert.doesNotMatch(rendered, /Loading usage data/);
});
