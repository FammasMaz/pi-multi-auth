import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AccountManager } from "../src/account-manager.js";
import { AuthWriter } from "../src/auth-writer.js";
import {
	isBlazeApiPlanEligibleForPremiumModel,
	modelPrefersFreePlan,
	modelRequiresEntitlement,
	normalizeBlazeApiPlanType,
	normalizeModelId,
	providerUsesPlanTierRanking,
	rankBlazeApiCredentialsByPlanTier,
} from "../src/model-entitlements.js";
import { resolveDefaultRotationMode } from "../src/rotation-modes.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { MultiAuthStorage } from "../src/storage.js";
import { UsageService } from "../src/usage/index.js";
import type { UsageAuth, UsageSnapshot } from "../src/usage/types.js";

const BLAZEAPI_PROVIDER_ID = "blazeapi";

type TestCredential = {
	credentialId: string;
	secret: string;
	planType: string | null;
	premiumUsedPercent?: number;
	primaryUsedPercent?: number;
	usageError?: string;
};

function createBlazeApiUsageSnapshot(
	credential: Pick<TestCredential, "planType" | "premiumUsedPercent" | "primaryUsedPercent">,
): UsageSnapshot {
	const now = Date.now();
	const planType = credential.planType;
	const hasPremiumBudget = planType !== null && planType.trim().toLowerCase() !== "free";
	const secondary = hasPremiumBudget
		? {
			usedPercent: credential.premiumUsedPercent ?? 0,
			windowMinutes: 24 * 60,
			resetsAt: now + 24 * 60 * 60_000,
		}
		: null;
	return {
		timestamp: now,
		provider: BLAZEAPI_PROVIDER_ID,
		planType,
		primary: {
			usedPercent: credential.primaryUsedPercent ?? 10,
			windowMinutes: 24 * 60,
			resetsAt: now + 24 * 60 * 60_000,
		},
		secondary,
		credits: null,
		copilotQuota: null,
		updatedAt: now,
	};
}

async function createBlazeApiAccountManager(
	t: TestContext,
	credentials: readonly TestCredential[],
): Promise<AccountManager> {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-blazeapi-entitlement-"));
	const authPath = join(tempRoot, "auth.json");
	const storagePath = join(tempRoot, "multi-auth.json");
	const modelsPath = join(tempRoot, "models.json");
	const credentialBySecret = new Map(credentials.map((credential) => [credential.secret, credential]));

	await writeFile(
		authPath,
		JSON.stringify(
			Object.fromEntries(
				credentials.map((credential) => [
					credential.credentialId,
					{ type: "api_key", key: credential.secret },
				]),
			),
			null,
			2,
		),
		"utf-8",
	);
	await writeFile(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");

	const authWriter = new AuthWriter(authPath);
	const storage = new MultiAuthStorage(storagePath);
	const usageService = new UsageService(undefined, undefined, undefined, undefined, { persistentCache: false });
	usageService.register({
		id: BLAZEAPI_PROVIDER_ID,
		displayName: "BlazeAPI",
		fetchUsage: async (auth: UsageAuth) => {
			const credential = credentialBySecret.get(auth.accessToken);
			if (credential?.usageError) {
				throw new Error(credential.usageError);
			}
			return createBlazeApiUsageSnapshot(credential ?? { planType: null });
		},
	});
	const providerRegistry = new ProviderRegistry(authWriter, modelsPath, [BLAZEAPI_PROVIDER_ID]);
	const accountManager = new AccountManager(authWriter, storage, usageService, providerRegistry);

	t.after(async () => {
		await accountManager.shutdown();
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	return accountManager;
}

async function preloadUsage(
	accountManager: AccountManager,
	credentialIds: readonly string[],
): Promise<void> {
	for (const credentialId of credentialIds) {
		await accountManager.getCredentialUsageSnapshot(BLAZEAPI_PROVIDER_ID, credentialId, {
			forceRefresh: true,
		});
	}
}

test("blazeapi default rotation mode is usage-based", () => {
	assert.equal(resolveDefaultRotationMode(BLAZEAPI_PROVIDER_ID), "usage-based");
});

test("normalizeBlazeApiPlanType recognizes the canonical plan labels", () => {
	assert.equal(normalizeBlazeApiPlanType("Free"), "free");
	assert.equal(normalizeBlazeApiPlanType("Pro"), "pro");
	assert.equal(normalizeBlazeApiPlanType("Premium"), "premium");
	assert.equal(normalizeBlazeApiPlanType("pro"), "pro");
	assert.equal(normalizeBlazeApiPlanType("Plus"), "unknown");
	assert.equal(normalizeBlazeApiPlanType(null), "unknown");
	assert.equal(normalizeBlazeApiPlanType(""), "unknown");
});

test("isBlazeApiPlanEligibleForPremiumModel only allows Pro and Premium", () => {
	assert.equal(isBlazeApiPlanEligibleForPremiumModel("pro"), true);
	assert.equal(isBlazeApiPlanEligibleForPremiumModel("premium"), true);
	assert.equal(isBlazeApiPlanEligibleForPremiumModel("free"), false);
	assert.equal(isBlazeApiPlanEligibleForPremiumModel("unknown"), false);
});

test("modelRequiresEntitlement flags BlazeAPI paid-only chat routes", () => {
	// `/api/models` can report `required_plan: "Free"`, but chat completions
	// rejects Free API keys for claude-opus-4.7 with `paid_plan_required`.
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "claude-opus-4.7"), true);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "claude-opus-4.6"), true);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "moonshotai/kimi-k2.6"), true);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "blazeapi/moonshotai/kimi-k2.6"), true);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "z-ai/glm-5.1"), true);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "qwen/qwen3.5-397b"), true);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "claude-opus-5.0"), true);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "claude-sonnet-4.5"), true);
});

test("normalizeModelId preserves BlazeAPI vendor namespaces while stripping only the provider prefix", () => {
	assert.equal(normalizeModelId("blazeapi/moonshotai/kimi-k2.6", BLAZEAPI_PROVIDER_ID), "moonshotai/kimi-k2.6");
	assert.equal(normalizeModelId("moonshotai/kimi-k2.6", BLAZEAPI_PROVIDER_ID), "moonshotai/kimi-k2.6");
	assert.equal(normalizeModelId("openai-codex/gpt-5.5", "openai-codex"), "gpt-5.5");
	assert.equal(normalizeModelId("blazeapi/moonshotai/kimi-k2.6"), "moonshotai/kimi-k2.6");
});

test("modelRequiresEntitlement does not flag free-tier BlazeAPI models", () => {
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "MiniMax-M2.5-highspeed"), false);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "z-ai/glm4.7"), false);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, "qwen3.6-plus"), false);
	assert.equal(modelRequiresEntitlement(BLAZEAPI_PROVIDER_ID, undefined), false);
});

test("providerUsesPlanTierRanking returns true only for blazeapi", () => {
	assert.equal(providerUsesPlanTierRanking(BLAZEAPI_PROVIDER_ID), true);
	assert.equal(providerUsesPlanTierRanking("openai-codex"), false);
	assert.equal(providerUsesPlanTierRanking("anthropic"), false);
});

test("modelPrefersFreePlan no longer treats BlazeAPI as free-plan-preferring", () => {
	// BlazeAPI now uses tier ranking (Premium → Pro → Free) instead of the
	// codex-style free-preference signal, so the flat helper must return false
	// for every BlazeAPI model regardless of premium-charging status.
	assert.equal(modelPrefersFreePlan(BLAZEAPI_PROVIDER_ID, "MiniMax-M2.5-highspeed"), false);
	assert.equal(modelPrefersFreePlan(BLAZEAPI_PROVIDER_ID, "qwen3.6-plus"), false);
	assert.equal(modelPrefersFreePlan(BLAZEAPI_PROVIDER_ID, "claude-opus-4.7"), false);
	assert.equal(modelPrefersFreePlan(BLAZEAPI_PROVIDER_ID, "moonshotai/kimi-k2.6"), false);
	// codex behavior preserved.
	assert.equal(modelPrefersFreePlan("openai-codex", "gpt-5.4"), true);
});

test("rankBlazeApiCredentialsByPlanTier orders Premium → Pro → Free and trails unknown plans", () => {
	const tiers = rankBlazeApiCredentialsByPlanTier(new Map([
		["a-free", "free"],
		["b-pro", "pro"],
		["c-premium", "premium"],
		["d-unknown", "unknown"],
		["e-pro", "pro"],
	]));
	assert.deepEqual(tiers.map((tier) => [...tier]), [
		["c-premium"],
		["b-pro", "e-pro"],
		["a-free"],
		["d-unknown"],
	]);

	// Empty tiers are dropped entirely.
	const tiersWithoutPremium = rankBlazeApiCredentialsByPlanTier(new Map([
		["a-free", "free"],
		["b-pro", "pro"],
	]));
	assert.deepEqual(tiersWithoutPremium.map((tier) => [...tier]), [
		["b-pro"],
		["a-free"],
	]);
});

test("account manager routes higher-cost BlazeAPI models to Premium credential first", async (t) => {
	const credentials: TestCredential[] = [
		{ credentialId: "blazeapi", secret: "blz_free", planType: "Free" },
		{ credentialId: "blazeapi-1", secret: "blz_pro", planType: "Pro" },
		{ credentialId: "blazeapi-2", secret: "blz_premium", planType: "Premium" },
	];
	const accountManager = await createBlazeApiAccountManager(t, credentials);
	await preloadUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(BLAZEAPI_PROVIDER_ID, {
		modelId: "claude-opus-4.7",
	});

	assert.equal(selected.credentialId, "blazeapi-2");
});

test("account manager routes free-tier BlazeAPI models to Premium first to benefit from faster pool priority", async (t) => {
	const credentials: TestCredential[] = [
		{ credentialId: "blazeapi", secret: "blz_free", planType: "Free" },
		{ credentialId: "blazeapi-1", secret: "blz_pro", planType: "Pro" },
		{ credentialId: "blazeapi-2", secret: "blz_premium", planType: "Premium" },
	];
	const accountManager = await createBlazeApiAccountManager(t, credentials);
	await preloadUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(BLAZEAPI_PROVIDER_ID, {
		modelId: "MiniMax-M2.5-highspeed",
	});

	assert.equal(selected.credentialId, "blazeapi-2");
});

test("account manager falls back from Premium to Pro when Premium daily requests are exhausted (free-tier model)", async (t) => {
	const credentials: TestCredential[] = [
		{ credentialId: "blazeapi", secret: "blz_free", planType: "Free" },
		{ credentialId: "blazeapi-1", secret: "blz_pro", planType: "Pro", primaryUsedPercent: 10 },
		{ credentialId: "blazeapi-2", secret: "blz_premium", planType: "Premium", primaryUsedPercent: 100 },
	];
	const accountManager = await createBlazeApiAccountManager(t, credentials);
	await preloadUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(BLAZEAPI_PROVIDER_ID, {
		modelId: "MiniMax-M2.5-highspeed",
	});

	assert.equal(selected.credentialId, "blazeapi-1");
});

test("account manager falls back from Premium and Pro to Free when both higher tiers are exhausted (free-tier model)", async (t) => {
	const credentials: TestCredential[] = [
		{ credentialId: "blazeapi", secret: "blz_free", planType: "Free", primaryUsedPercent: 10 },
		{ credentialId: "blazeapi-1", secret: "blz_pro", planType: "Pro", primaryUsedPercent: 100 },
		{ credentialId: "blazeapi-2", secret: "blz_premium", planType: "Premium", primaryUsedPercent: 100 },
	];
	const accountManager = await createBlazeApiAccountManager(t, credentials);
	await preloadUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(BLAZEAPI_PROVIDER_ID, {
		modelId: "MiniMax-M2.5-highspeed",
	});

	assert.equal(selected.credentialId, "blazeapi");
});

test("account manager skips premium-credit-exhausted Premium credentials and falls back to Pro for higher-cost models", async (t) => {
	const credentials: TestCredential[] = [
		{ credentialId: "blazeapi", secret: "blz_free", planType: "Free" },
		{ credentialId: "blazeapi-1", secret: "blz_pro", planType: "Pro", premiumUsedPercent: 10 },
		{ credentialId: "blazeapi-2", secret: "blz_premium_exhausted", planType: "Premium", premiumUsedPercent: 100 },
	];
	const accountManager = await createBlazeApiAccountManager(t, credentials);
	await preloadUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(BLAZEAPI_PROVIDER_ID, {
		modelId: "claude-opus-4.7",
	});

	assert.equal(selected.credentialId, "blazeapi-1");
});

test("account manager keeps BlazeAPI accounts usable for free models when only premium credits are exhausted", async (t) => {
	const credentials: TestCredential[] = [
		{
			credentialId: "blazeapi-1",
			secret: "blz_premium_exhausted",
			planType: "Premium",
			primaryUsedPercent: 10,
			premiumUsedPercent: 100,
		},
	];
	const accountManager = await createBlazeApiAccountManager(t, credentials);
	await preloadUsage(accountManager, credentials.map((credential) => credential.credentialId));

	const selected = await accountManager.acquireCredential(BLAZEAPI_PROVIDER_ID, {
		modelId: "MiniMax-M2.5-highspeed",
	});
	const status = await accountManager.getProviderStatus(BLAZEAPI_PROVIDER_ID);

	assert.equal(selected.credentialId, status.credentials[0]?.credentialId);
	assert.equal(status.credentials[0]?.quotaExhaustedUntil, undefined);
});

test("account manager rejects paid-only BlazeAPI models when only Free credentials are available", async (t) => {
	const credentials: TestCredential[] = [
		{ credentialId: "blazeapi", secret: "blz_free_a", planType: "Free" },
		{ credentialId: "blazeapi-1", secret: "blz_free_b", planType: "Free" },
	];
	const accountManager = await createBlazeApiAccountManager(t, credentials);
	await preloadUsage(accountManager, credentials.map((credential) => credential.credentialId));

	await assert.rejects(
		() => accountManager.acquireCredential(BLAZEAPI_PROVIDER_ID, { modelId: "claude-opus-4.7" }),
		/No BlazeAPI credentials with premium daily credits/i,
	);
});

test("account manager falls back to stale BlazeAPI plan evidence when live usage lookup fails", async (t) => {
	const credentials: TestCredential[] = [
		{ credentialId: "blazeapi", secret: "blz_free", planType: "Free" },
		{ credentialId: "blazeapi-1", secret: "blz_premium", planType: "Premium" },
	];
	const accountManager = await createBlazeApiAccountManager(t, credentials);
	await preloadUsage(accountManager, credentials.map((credential) => credential.credentialId));

	for (const credential of credentials) {
		credential.usageError = "BlazeAPI usage endpoint unavailable";
	}

	const originalDateNow = Date.now;
	Date.now = () => originalDateNow() + 20_000;
	t.after(() => {
		Date.now = originalDateNow;
	});

	const selected = await accountManager.acquireCredential(BLAZEAPI_PROVIDER_ID, {
		modelId: "claude-opus-4.7",
	});

	assert.equal(selected.credentialId, "blazeapi-1");
});
