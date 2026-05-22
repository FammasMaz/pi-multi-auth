import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MultiAuthDebugLogger } from "../src/debug-logger.js";

// --- Debug Logger Secret Redaction Tests ---

test("MultiAuthDebugLogger redacts sensitive token values in log output", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-redact-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const configPath = join(tempRoot, "config.json");
	const debugDir = join(tempRoot, "debug");
	const logPath = join(debugDir, "pi-multi-auth-debug.jsonl");
	await writeFile(configPath, JSON.stringify({ debug: true }, null, 2), "utf-8");

	const logger = new MultiAuthDebugLogger({
		configPath,
		debugDir,
		logPath,
	});

	logger.log("oauth_token_refresh", {
		accessToken: "super-secret-access-token-value-12345",
		refreshToken: "super-secret-refresh-token-value-67890",
		clientSecret: "my-client-secret-abcdef",
		apiKey: "sk-1234567890abcdef",
		authorization: "Bearer my-secret-bearer-token",
		password: "my-password-123",
		nonSensitiveField: "this-should-be-visible",
		provider: "qwen",
	});
	await logger.flush();

	const logContent = await readFile(logPath, "utf-8");
	const entry = JSON.parse(logContent.trim().split(/\r?\n/)[0] ?? "{}") as Record<string, unknown>;

	assert.equal(entry.event, "oauth_token_refresh");
	assert.equal(entry.nonSensitiveField, "this-should-be-visible");
	assert.equal(entry.provider, "qwen");
	assert.notEqual(entry.accessToken, "super-secret-access-token-value-12345");
	assert.notEqual(entry.refreshToken, "super-secret-refresh-token-value-67890");
	assert.notEqual(entry.clientSecret, "my-client-secret-abcdef");
	assert.notEqual(entry.apiKey, "sk-1234567890abcdef");
	assert.notEqual(entry.authorization, "Bearer my-secret-bearer-token");
	assert.notEqual(entry.password, "my-password-123");
	assert.equal(JSON.stringify(entry).includes("super-secret-access-token"), false);
	assert.equal(JSON.stringify(entry).includes("super-secret-refresh-token"), false);
	assert.equal(JSON.stringify(entry).includes("my-client-secret-abcdef"), false);
	assert.equal(JSON.stringify(entry).includes("sk-1234567890abcdef"), false);
	assert.equal(JSON.stringify(entry).includes("my-secret-bearer-token"), false);
	assert.equal(JSON.stringify(entry).includes("my-password-123"), false);
});

test("MultiAuthDebugLogger preserves non-sensitive nested fields alongside redacted fields", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-redact-nested-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const configPath = join(tempRoot, "config.json");
	const debugDir = join(tempRoot, "debug");
	const logPath = join(debugDir, "pi-multi-auth-debug.jsonl");
	await writeFile(configPath, JSON.stringify({ debug: true }, null, 2), "utf-8");

	const logger = new MultiAuthDebugLogger({
		configPath,
		debugDir,
		logPath,
	});

	logger.log("provider_login", {
		provider: "qwen",
		attempt: 2,
		nested: {
			token: "should-not-leak",
			status: "pending",
		},
	});
	await logger.flush();

	const logContent = await readFile(logPath, "utf-8");
	const entry = JSON.parse(logContent.trim().split(/\r?\n/)[0] ?? "{}") as Record<string, unknown>;

	assert.equal(entry.provider, "qwen");
	assert.equal(entry.attempt, 2);
	const nested = entry.nested as Record<string, unknown>;
	assert.equal(nested.status, "pending");
	assert.notEqual(nested.token, "should-not-leak");
	assert.equal(JSON.stringify(entry).includes("should-not-leak"), false);
});
