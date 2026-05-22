import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_MULTI_AUTH_CONFIG,
	loadMultiAuthConfig,
} from "../src/config.js";
import { MultiAuthDebugLogger } from "../src/debug-logger.js";
import {
	acquireFileLock,
	ensureFileExists,
	ensureParentDir,
	hardenCredentialFilePermissions,
	lockDirPath,
	pathExists,
} from "../src/file-utils.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

const TEST_LOCK_OPTIONS = {
	realpath: false,
	retries: {
		retries: 5,
		factor: 1,
		minTimeout: 5,
		maxTimeout: 5,
		randomize: false,
	},
	stale: 30_000,
};

test("shared file utilities create credential files and harden POSIX permissions", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-file-utils-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const filePath = join(tempRoot, "nested", "auth.json");
	assert.equal(await pathExists(filePath), false);

	await ensureParentDir(filePath);
	await ensureFileExists(filePath, "{}");

	assert.equal(await pathExists(filePath), true);
	assert.equal(await readFile(filePath, "utf-8"), "{}");

	if (process.platform !== "win32") {
		assert.equal((await stat(filePath)).mode & 0o777, 0o600);
		await chmod(filePath, 0o644);
		await hardenCredentialFilePermissions(filePath);
		assert.equal((await stat(filePath)).mode & 0o777, 0o600);
	}
});

test("shared file lock utility retries busy locks and releases cleanly", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-lock-retry-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const filePath = join(tempRoot, "multi-auth.json");
	await writeFile(filePath, "{}", "utf-8");
	const releaseFirst = await acquireFileLock(filePath, TEST_LOCK_OPTIONS);
	let retryCount = 0;

	const secondLock = acquireFileLock(filePath, TEST_LOCK_OPTIONS, {
		onRetry: () => {
			retryCount += 1;
		},
	});
	await sleep(10);
	await releaseFirst();
	const releaseSecond = await secondLock;
	await releaseSecond();

	assert.equal(retryCount > 0, true);
	assert.equal(await pathExists(lockDirPath(filePath)), false);
});

test("shared file lock utility removes stale lock directories before acquiring", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-lock-stale-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const filePath = join(tempRoot, "auth.json");
	await writeFile(filePath, "{}", "utf-8");
	const lockPath = lockDirPath(filePath);
	await mkdir(lockPath, { mode: 0o700 });
	const oldDate = new Date(Date.now() - 60_000);
	await utimes(lockPath, oldDate, oldDate);
	let staleRemoved = false;
	let compromised = false;

	const release = await acquireFileLock(
		filePath,
		{
			...TEST_LOCK_OPTIONS,
			stale: 1,
			onCompromised: () => {
				compromised = true;
			},
		},
		{
			onStaleLockRemoved: () => {
				staleRemoved = true;
			},
		},
	);
	await release();

	assert.equal(staleRemoved, true);
	assert.equal(compromised, true);
	assert.equal(await pathExists(lockPath), false);
});

test("debug logger redacts OAuth access and refresh fields", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-oauth-redact-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const configPath = join(tempRoot, "config.json");
	const debugDir = join(tempRoot, "debug");
	const logPath = join(debugDir, "pi-multi-auth-debug.jsonl");
	const oauthA = "oauth-a-value-should-not-leak";
	const oauthR = "oauth-r-value-should-not-leak";
	const oauthCredential = Object.fromEntries([
		["type", "oauth"],
		["access", oauthA],
		["refresh", oauthR],
		["expires", 123],
	]);
	await writeFile(configPath, JSON.stringify({ debug: true }, null, 2), "utf-8");
	const logger = new MultiAuthDebugLogger({ configPath, debugDir, logPath });

	logger.log("oauth_credential", {
		provider: "openai-codex",
		credential: oauthCredential,
	});
	await logger.flush();

	const logContent = await readFile(logPath, "utf-8");
	const entry = JSON.parse(logContent.trim().split(/\r?\n/)[0] ?? "{}") as Record<string, unknown>;
	const credential = entry.credential as Record<string, unknown>;
	assert.equal(credential.access, "[REDACTED]");
	assert.equal(credential.refresh, "[REDACTED]");
	assert.equal(JSON.stringify(entry).includes(oauthA), false);
	assert.equal(JSON.stringify(entry).includes(oauthR), false);
});

test("multi-auth config defaults keep history disabled and Codex entitlement lookups strict", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-config-defaults-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const configPath = join(tempRoot, "config.json");
	const configResult = loadMultiAuthConfig(configPath);
	const configContent = JSON.parse(await readFile(configPath, "utf-8")) as typeof DEFAULT_MULTI_AUTH_CONFIG;

	assert.equal(DEFAULT_MULTI_AUTH_CONFIG.historyPersistence.enabled, false);
	assert.equal(DEFAULT_MULTI_AUTH_CONFIG.modelEntitlements.codex.usageLookupFailureMode, "strict");
	assert.equal(configResult.config.historyPersistence.enabled, false);
	assert.equal(configResult.config.modelEntitlements.codex.usageLookupFailureMode, "strict");
	assert.equal(configContent.historyPersistence.enabled, false);
	assert.equal(configContent.modelEntitlements.codex.usageLookupFailureMode, "strict");
});
