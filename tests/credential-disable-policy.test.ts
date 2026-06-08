import test from "node:test";
import assert from "node:assert/strict";
import {
	isRotationSummaryError,
	isReauthOnlyError,
	shouldPermanentlyDisableCredential,
} from "../src/credential-disable-policy.js";
import { classifyCredentialError } from "../src/error-classifier.js";

test("rotation summary errors must not disable credentials", () => {
	const msg =
		"All credentials are unavailable\nProvider: openai-codex\nModel: gpt-5.5\nCredentials: 203";
	assert.equal(isRotationSummaryError(msg), true);
	assert.equal(shouldPermanentlyDisableCredential(msg, "unknown"), false);
	const c = classifyCredentialError(msg, { providerId: "openai-codex", modelId: "gpt-5.5" });
	assert.equal(c.shouldDisableCredential, false);
});

test("expired token messages are reauth-only, not permanent disable", () => {
	const msg = "Provided authentication token is expired. Please try signing in again.";
	assert.equal(isReauthOnlyError(msg), true);
	assert.equal(shouldPermanentlyDisableCredential(msg, "authentication"), false);
	const c = classifyCredentialError(msg, { providerId: "openai-codex" });
	assert.equal(c.shouldDisableCredential, false);
});

test("token_revoked still disables", () => {
	const msg =
		"Encountered invalidated oauth token for user, failing request (code: token_revoked, status: 401)";
	const c = classifyCredentialError(msg, { providerId: "openai-codex", modelId: "gpt-5.4" });
	assert.equal(c.shouldDisableCredential, true);
	assert.equal(shouldPermanentlyDisableCredential(msg, c.kind), true);
});