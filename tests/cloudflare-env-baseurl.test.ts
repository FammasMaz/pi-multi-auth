import assert from "node:assert/strict";
import test from "node:test";
import { resolveCloudflareWorkersAiBaseUrlFromCredential } from "../src/credential-request-overrides.js";
import type { StoredApiKeyCredential } from "../src/types.js";

test("resolveCloudflareWorkersAiBaseUrlFromCredential uses env.CLOUDFLARE_ACCOUNT_ID", () => {
	const credential: StoredApiKeyCredential & { env?: Record<string, string> } = {
		type: "api_key",
		key: "cfut_example_token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "f375c92e4928eedf49cb43a1273f4897",
		},
	};
	const baseUrl = resolveCloudflareWorkersAiBaseUrlFromCredential(credential);
	assert.equal(
		baseUrl,
		"https://api.cloudflare.com/client/v4/accounts/f375c92e4928eedf49cb43a1273f4897/ai/v1",
	);
});