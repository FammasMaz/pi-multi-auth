import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultMultiAuthState, MultiAuthStorage } from "../src/storage.js";

test("multi-auth storage persists sparse provider state and rehydrates defaults", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-sparse-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const storage = new MultiAuthStorage(storagePath);
	await storage.withLock(() => {
		const next = createDefaultMultiAuthState(["sparse-provider"]);
		next.providers["sparse-provider"].credentialIds = ["credential-a"];
		next.providers["sparse-provider"].usageCount["credential-a"] = 2;
		return { result: undefined, next };
	});

	const persisted = JSON.parse(await readFile(storagePath, "utf-8")) as {
		providers: Record<string, Record<string, unknown>>;
	};
	const provider = persisted.providers["sparse-provider"];
	assert.deepEqual(provider.credentialIds, ["credential-a"]);
	assert.deepEqual(provider.usageCount, { "credential-a": 2 });
	assert.equal("lastUsedAt" in provider, false);
	assert.equal("quotaErrorCount" in provider, false);
	assert.equal("disabledCredentials" in provider, false);
	assert.equal("oauthRefreshScheduled" in provider, false);

	const rehydrated = await storage.readProviderState("sparse-provider");
	assert.deepEqual(rehydrated.lastUsedAt, {});
	assert.deepEqual(rehydrated.quotaErrorCount, {});
	assert.deepEqual(rehydrated.disabledCredentials, {});
	assert.deepEqual(rehydrated.oauthRefreshScheduled, {});
	assert.deepEqual(rehydrated.credentialIds, ["credential-a"]);
	assert.equal(rehydrated.usageCount["credential-a"], 2);
});

test("multi-auth storage sparsifies all optional provider fields and rehydrates correctly", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-full-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	// Write raw JSON with all complex fields populated to test sparse serialization
	const rawJson = {
		version: 1,
		providers: {
			"all-fields-provider": {
				credentialIds: ["cred-a", "cred-b"],
				activeIndex: 1,
				rotationMode: "usage-based",
				manualActiveCredentialId: "cred-a",
				lastUsedAt: { "cred-a": 1000, "cred-b": 2000 },
				usageCount: { "cred-a": 10, "cred-b": 5 },
				quotaErrorCount: { "cred-a": 1 },
				quotaErrorLastSeenAt: { "cred-a": 3000 },
				quotaRecoverySuccessCount: { "cred-a": 2 },
				quotaExhaustedUntil: { "cred-a": 4000 },
				lastQuotaError: { "cred-a": "rate limited" },
				lastTransientError: { "cred-a": "timeout" },
				transientErrorCount: { "cred-a": 3 },
				weeklyQuotaAttempts: { "cred-a": 50 },
				friendlyNames: { "cred-a": "Primary Key" },
				disabledCredentials: { "cred-b": { error: "quota exceeded", disabledAt: 5000, planType: "free" } },
				oauthRefreshScheduled: { "cred-a": 6000 },
				cascadeState: {
					"provider-b": {
						active: {
							cascadeId: "cascade-1",
							cascadePath: [{
								providerId: "provider-b",
								credentialId: "cred-b",
								attemptedAt: 1000,
								errorKind: "quota",
								errorMessage: "Quota exceeded",
								recoveryAction: "cooldown",
							}],
							attemptCount: 1,
							startedAt: 1000,
							lastAttemptAt: 1000,
							nextRetryAt: 2000,
							isActive: true,
						},
						history: [],
					},
				},
				healthState: {
					scores: {
						"cred-a": { credentialId: "cred-a", score: 0.95, calculatedAt: 1000, components: { successRate: 0.9, latencyFactor: 0.8, uptimeFactor: 1.0, recoveryFactor: 0.95 }, isStale: false },
					},
					configHash: "abc123",
				},
				pools: [{
					poolId: "pool-1",
					displayName: "Primary Pool",
					credentialIds: ["cred-a", "cred-b"],
					priority: 1,
					poolMode: "round-robin",
					maxConcurrent: 2,
					healthThreshold: 0.8,
					config: { cooldownMs: 5000, backoffMultiplier: 2 },
				}],
				poolConfig: { enablePools: false, failoverStrategy: "health-based", preferHealthyWithinPool: true },
				poolState: { activePoolId: "pool-1", poolIndex: 0 },
				chains: [{
					chainId: "chain-1",
					displayName: "Main Chain",
					providers: [
						{ providerId: "provider-a", modelMapping: { "gpt-4": "gpt-4-turbo" }, healthThreshold: 0.7, maxAttempts: 3 },
						{ providerId: "provider-b" },
					],
					maxAttemptsPerProvider: 2,
					failoverTriggers: ["quota", "balance_exhausted"],
				}],
				activeChain: {
					chainId: "chain-1",
					position: 0,
					currentProviderId: "provider-a",
					attemptsOnCurrentProvider: 1,
					failoverReason: "quota",
					failoverStartedAt: 7000,
					failedProviders: [{ providerId: "provider-b", failedAt: 7000, reason: "quota exceeded", errorKind: "quota" }],
				},
				quotaStates: {
					"cred-a": {
						credentialId: "cred-a",
						classification: "hourly",
						detectedAt: 8000,
						resetAt: 9000,
						errorMessage: "Rate limited",
						recoveryAction: { action: "switch_credential", requiresManual: false, estimatedWaitMs: 60000, description: "Try another credential" },
					},
				},
				quotaDrainStates: {
					"cred-a": { draining: true, enteredAt: 8000, lastUsedPercent: 95, updatedAt: 8500 },
				},
				modelIncompatibilities: {
					"cred-a": {
						"gpt-4": { modelId: "gpt-4", blockedUntil: 99000, blockedAt: 8000, error: "Insufficient quota for model" },
					},
				},
				credentialLeases: {
					"agent-1": { ownerId: "agent-1", credentialId: "cred-a", acquiredAt: 8000, lastSeenAt: 8500, expiresAt: 90000 },
				},
			},
		},
	};
	await writeFile(storagePath, JSON.stringify(rawJson, null, 2), "utf-8");

	const storage = new MultiAuthStorage(storagePath);
	const rehydrated = await storage.readProviderState("all-fields-provider");

	// Verify all populated fields survive round-trip
	assert.deepEqual(rehydrated.credentialIds, ["cred-a", "cred-b"]);
	assert.equal(rehydrated.activeIndex, 1);
	assert.equal(rehydrated.rotationMode, "usage-based");
	assert.equal(rehydrated.manualActiveCredentialId, "cred-a");
	assert.deepEqual(rehydrated.lastUsedAt, { "cred-a": 1000, "cred-b": 2000 });
	assert.deepEqual(rehydrated.usageCount, { "cred-a": 10, "cred-b": 5 });
	assert.deepEqual(rehydrated.quotaErrorCount, { "cred-a": 1 });
	assert.deepEqual(rehydrated.quotaErrorLastSeenAt, { "cred-a": 3000 });
	assert.deepEqual(rehydrated.quotaRecoverySuccessCount, { "cred-a": 2 });
	assert.deepEqual(rehydrated.quotaExhaustedUntil, { "cred-a": 4000 });
	assert.deepEqual(rehydrated.lastQuotaError, { "cred-a": "rate limited" });
	assert.deepEqual(rehydrated.transientErrorCount, { "cred-a": 3 });
	assert.deepEqual(rehydrated.weeklyQuotaAttempts, { "cred-a": 50 });
	assert.deepEqual(rehydrated.friendlyNames, { "cred-a": "Primary Key" });
	assert.equal(rehydrated.disabledCredentials["cred-b"]?.error, "quota exceeded");
	assert.deepEqual(rehydrated.oauthRefreshScheduled, { "cred-a": 6000 });
	assert.ok(rehydrated.cascadeState !== undefined);
	assert.ok(rehydrated.healthState !== undefined);
	assert.equal(rehydrated.healthState?.scores["cred-a"]?.score, 0.95);
	assert.equal(rehydrated.pools?.length, 1);
	assert.equal(rehydrated.pools?.[0]?.poolId, "pool-1");
	assert.ok(rehydrated.poolConfig !== undefined);
	assert.equal(rehydrated.poolConfig?.enablePools, false);
	assert.equal(rehydrated.poolState?.activePoolId, "pool-1");
	assert.equal(rehydrated.chains?.length, 1);
	assert.equal(rehydrated.chains?.[0]?.chainId, "chain-1");
	assert.ok(rehydrated.activeChain !== undefined);
	assert.equal(rehydrated.activeChain?.currentProviderId, "provider-a");
	assert.equal(rehydrated.quotaStates?.["cred-a"]?.classification, "hourly");
	assert.equal(rehydrated.quotaDrainStates?.["cred-a"]?.draining, true);
	assert.ok(rehydrated.modelIncompatibilities !== undefined);
	assert.equal(rehydrated.credentialLeases?.["agent-1"]?.credentialId, "cred-a");

	// Write new provider without complex fields — verify they're omitted in JSON
	await storage.withLock(() => {
		const next = createDefaultMultiAuthState(["empty-provider"]);
		next.providers["empty-provider"].credentialIds = ["cred-c"];
		return { result: undefined, next };
	});

	const persisted = JSON.parse(await readFile(storagePath, "utf-8")) as Record<string, unknown>;
	const emptyProvider = (persisted as Record<string, unknown>)["providers"] as Record<string, unknown>;
	const emptyP = (emptyProvider as Record<string, unknown>)["empty-provider"] as Record<string, unknown>;
	assert.equal("cascadeState" in emptyP, false);
	assert.equal("healthState" in emptyP, false);
	assert.equal("pools" in emptyP, false);
	assert.equal("poolConfig" in emptyP, false);
	assert.equal("poolState" in emptyP, false);
	assert.equal("chains" in emptyP, false);
	assert.equal("activeChain" in emptyP, false);
	assert.equal("quotaStates" in emptyP, false);
	assert.equal("quotaDrainStates" in emptyP, false);
	assert.equal("modelIncompatibilities" in emptyP, false);
	assert.equal("credentialLeases" in emptyP, false);

	const emptyRehydrated = await storage.readProviderState("empty-provider");
	assert.equal(emptyRehydrated.cascadeState, undefined);
	assert.equal(emptyRehydrated.healthState, undefined);
	assert.equal(emptyRehydrated.pools, undefined);
	assert.equal(emptyRehydrated.poolConfig, undefined);
	assert.equal(emptyRehydrated.chains, undefined);
	assert.equal(emptyRehydrated.activeChain, undefined);
	assert.equal(emptyRehydrated.quotaStates, undefined);
	assert.equal(emptyRehydrated.credentialLeases, undefined);
	assert.deepEqual(emptyRehydrated.credentialIds, ["cred-c"]);
});

test("multi-auth storage falls back to defaults for invalid provider state fields", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-invalid-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	// Write raw JSON with intentionally malformed fields
	const rawState = {
		version: 1,
		providers: {
			"invalid-provider": {
				credentialIds: "not-an-array",
				activeIndex: -1,
				rotationMode: "invalid-mode",
				manualActiveCredentialId: "   ",
				lastUsedAt: null,
				quotaErrorCount: "not-a-map",
				cascadeState: "not-an-object",
				healthState: 42,
				pools: "not-an-array",
				poolConfig: "invalid",
				poolState: null,
				chains: ["not-a-record"],
				activeChain: { chainId: "", currentProviderId: "" },
				quotaStates: "invalid",
			},
		},
	};
	await writeFile(storagePath, JSON.stringify(rawState, null, 2), "utf-8");

	const storage = new MultiAuthStorage(storagePath);
	const rehydrated = await storage.readProviderState("invalid-provider");

	// Verify all invalid fields fall back to safe defaults
	assert.deepEqual(rehydrated.credentialIds, []);
	assert.equal(rehydrated.activeIndex, 0);
	assert.equal(rehydrated.rotationMode, "round-robin");
	assert.equal(rehydrated.manualActiveCredentialId, undefined);
	assert.deepEqual(rehydrated.lastUsedAt, {});
	assert.deepEqual(rehydrated.quotaErrorCount, {});
	assert.equal(rehydrated.cascadeState, undefined);
	assert.equal(rehydrated.healthState, undefined);
	assert.equal(rehydrated.pools, undefined);
	assert.equal(rehydrated.poolConfig, undefined);
	assert.equal(rehydrated.poolState, undefined);
	assert.equal(rehydrated.chains, undefined);
	assert.equal(rehydrated.activeChain, undefined);
	assert.equal(rehydrated.quotaStates, undefined);
});

test("multi-auth storage handles empty file content and returns default state", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-empty-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	// Write empty file (whitespace-only) then read
	await writeFile(storagePath, "   ", "utf-8");
	const storage = new MultiAuthStorage(storagePath);
	const state = await storage.read();
	assert.equal(state.version, 1);
	assert.deepEqual(state.providers, {});

	// Write empty string
	await writeFile(storagePath, "", "utf-8");
	const state2 = await storage.read();
	assert.equal(state2.version, 1);
	assert.deepEqual(state2.providers, {});
});

test("multi-auth storage handles non-record parsed value and returns default state", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-array-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	// Write a JSON array (not an object) — parseState returns default for non-record
	await writeFile(storagePath, JSON.stringify(["not", "an", "object"]), "utf-8");
	const storage = new MultiAuthStorage(storagePath);
	// parseState should detect non-record and return default state without throwing
	const state = await storage.read();
	assert.equal(state.version, 1);
	assert.deepEqual(state.providers, {});
});

test("multi-auth storage sparse write is idempotent across consecutive round-trips", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-idempotent-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const storage = new MultiAuthStorage(storagePath);

	// First withLock: populate provider with all complex fields
	await storage.withLock(() => {
		const next = createDefaultMultiAuthState(["idempotent-provider"]);
		next.providers["idempotent-provider"].credentialIds = ["cred-a", "cred-b"];
		next.providers["idempotent-provider"].activeIndex = 1;
		next.providers["idempotent-provider"].usageCount = { "cred-a": 10, "cred-b": 5 };
		next.providers["idempotent-provider"].lastUsedAt = { "cred-a": 1000, "cred-b": 2000 };
		next.providers["idempotent-provider"].quotaErrorCount = { "cred-a": 1 };
		next.providers["idempotent-provider"].disabledCredentials = {
			"cred-b": { error: "quota exceeded", disabledAt: 5000, planType: "free" },
		};
		next.providers["idempotent-provider"].oauthRefreshScheduled = { "cred-a": 6000 };
		next.providers["idempotent-provider"].friendlyNames = { "cred-a": "Primary Key" };
		return { result: undefined, next };
	});

	// Read file content after first write
	const contentA = await readFile(storagePath, "utf-8");
	const metricsAfterFirst = storage.getMetrics();
	assert.equal(metricsAfterFirst.cacheMissCount >= 1, true, "First write triggered at least one cache miss");

	// Second withLock: return the same state unchanged (via read + re-write via withLock)
	const secondResult = await storage.withLock(async (state) => {
		// Return state unchanged (it's already cloned)
		return { result: undefined, next: state };
	});
	assert.equal(secondResult, undefined);

	// Read file content after second withLock — must be identical
	const contentB = await readFile(storagePath, "utf-8");
	assert.equal(contentB, contentA, "File content must not change when state is identical");

	// Cache miss count should NOT have increased for the withLock's read step
	// (the file was written in first withLock, so second withLock's readCachedSnapshotReference
	// hits cache since fingerprint hasn't changed)
	const metricsAfterSecond = storage.getMetrics();
	assert.equal(
		metricsAfterSecond.cacheMissCount,
		metricsAfterFirst.cacheMissCount,
		"No additional cache miss on second round-trip with identical state",
	);
	assert.equal(
		metricsAfterSecond.cacheHitCount > metricsAfterFirst.cacheHitCount,
		true,
		"Cache hit count increased on second round-trip",
	);

	// Third round-trip: verify same behavior persists
	await storage.withLock(async (state) => {
		return { result: undefined, next: state };
	});
	const contentC = await readFile(storagePath, "utf-8");
	assert.equal(contentC, contentA, "File content must not change on third round-trip either");

	const metricsAfterThird = storage.getMetrics();
	assert.equal(
		metricsAfterThird.cacheMissCount,
		metricsAfterFirst.cacheMissCount,
		"No additional cache miss on third round-trip",
	);
});

test("multi-auth storage cache fingerprint correctly invalidates after size change", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-fingerprint-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const storage = new MultiAuthStorage(storagePath);

	// First read populates cache
	const state1 = await storage.read();
	assert.equal(state1.version, 1);

	// Second read with same fingerprint should hit cache
	const metrics1 = storage.getMetrics();
	assert.equal(metrics1.cacheHitCount >= 0, true);

	const state2 = await storage.read();
	const metrics2 = storage.getMetrics();
	// At least one cache miss from first read, should have hits now
	assert.equal(metrics2.cacheHitCount > 0, true);
	assert.equal(metrics2.cacheMissCount, 1);

	// Modify the file externally to invalidate fingerprint
	await writeFile(storagePath, JSON.stringify({
		version: 1,
		providers: {
			"external-provider": { credentialIds: ["ext-cred"], activeIndex: 0, rotationMode: "round-robin" },
		},
	}), "utf-8");

	// Read again — should miss cache due to fingerprint change
	const state3 = await storage.read();
	const metrics3 = storage.getMetrics();
	assert.equal(metrics3.cacheMissCount, 2);
	assert.equal(state3.providers["external-provider"]?.credentialIds[0], "ext-cred");
});

test("multi-auth storage recovers corrupted primary JSON from backup", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-recovery-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	const backupState = createDefaultMultiAuthState(["recovered-provider"]);
	backupState.providers["recovered-provider"].credentialIds = ["cred-a"];
	await writeFile(storagePath, "{", "utf-8");
	await writeFile(`${storagePath}.bak`, JSON.stringify(backupState, null, 2), "utf-8");

	const storage = new MultiAuthStorage(storagePath);
	const recovered = await storage.readProviderState("recovered-provider");

	assert.deepEqual(recovered.credentialIds, ["cred-a"]);
	assert.equal(JSON.parse(await readFile(storagePath, "utf-8")).providers["recovered-provider"].credentialIds[0], "cred-a");
});

test("multi-auth storage falls back to default when primary and backup JSON are corrupted", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-storage-recovery-default-"));
	const storagePath = join(tempRoot, "multi-auth.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await writeFile(storagePath, "{", "utf-8");
	await writeFile(`${storagePath}.bak`, "{", "utf-8");

	const storage = new MultiAuthStorage(storagePath);
	const state = await storage.read();

	assert.equal(state.version, 1);
	assert.deepEqual(state.providers, {});
});
