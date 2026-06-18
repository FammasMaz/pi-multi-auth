import assert from "node:assert/strict";
import test from "node:test";
import { parseCloudflareCredentialBatchInput } from "../src/cloudflare-credential-input.js";

test("parseCloudflareCredentialBatchInput pairs token with standalone account id line", () => {
	const result = parseCloudflareCredentialBatchInput(
		[
			"cfat_test_token_value_abcdefghijklmnop",
			"a1b2c3d4e5f6789012345678901234ab",
		].join("\n"),
	);
	assert.equal(result.ok, true);
	if (!result.ok) {
		return;
	}
	assert.equal(result.entries.length, 1);
	assert.match(result.entries[0]?.request?.baseUrl ?? "", /a1b2c3d4e5f6789012345678901234ab/);
});

test("parseCloudflareCredentialBatchInput ignores comment lines", () => {
	const result = parseCloudflareCredentialBatchInput(
		[
			"# account id below",
			"cfat_test_token_value_abcdefghijklmnop",
			"a1b2c3d4e5f6789012345678901234ab",
		].join("\n"),
	);
	assert.equal(result.ok, true);
	if (!result.ok) {
		return;
	}
	assert.equal(result.entries[0]?.request?.baseUrl?.includes("a1b2c3d4"), true);
});