import type { SupportedProviderId } from "./types.js";

/**
 * Normalized Codex plan types used for entitlement checks.
 */
export type CodexPlanType =
	| "free"
	| "plus"
	| "pro"
	| "team"
	| "business"
	| "enterprise"
	| "unknown";

/**
 * Normalized BlazeAPI plan types used for entitlement checks. BlazeAPI uses
 * user-facing labels (e.g. "Free", "Pro", "Premium") returned by `/api/usage`
 * via `plan.name`.
 */
export type BlazeApiPlanType = "free" | "pro" | "premium" | "unknown";

/**
 * Normalized Kiro plan types returned by the usage endpoint subscription info.
 * Kiro exposes user-facing labels such as `KIRO FREE`, `Kiro Pro+`, and
 * `Power`; unknown labels remain ineligible for paid-only model routing.
 */
export type KiroPlanType = "free" | "pro" | "pro-plus" | "power" | "unknown";

/**
 * Result returned when model-specific credential eligibility has been resolved.
 */
export interface CredentialModelEligibility {
	appliesConstraint: boolean;
	eligibleCredentialIds: readonly string[];
	ineligibleCredentialIds: readonly string[];
	/** Credential IDs that should be attempted before other eligible credentials. */
	preferredCredentialIds?: readonly string[];
	/**
	 * Ordered preference tiers, highest priority first. Each tier is tried as its
	 * own selection pass before falling back to the next tier and finally to the
	 * full eligible set. Used to express provider-specific plan rankings such as
	 * BlazeAPI's Premium → Pro → Free order. When omitted, callers fall back to
	 * the flat `preferredCredentialIds` list.
	 */
	preferredCredentialTiers?: readonly (readonly string[])[];
	failureMessage?: string;
}

const OPENAI_CODEX_FREE_BLOCKED_MODEL_IDS = new Set([
	"gpt-5-mini",
]);
const OPENAI_CODEX_FREE_BLOCKED_MODEL_PATTERNS: readonly RegExp[] = [
	/^gpt-(?:[6-9]|\d{2,})(?:[.-][a-z0-9]+)*$/,
];
const OPENAI_CODEX_PAID_PLAN_TYPES = new Set<CodexPlanType>([
	"plus",
	"pro",
	"team",
	"business",
	"enterprise",
]);

const BLAZEAPI_PROVIDER_ID = "blazeapi";
const KIRO_PROVIDER_ID = "kiro";

function normalizeProviderId(providerId: SupportedProviderId): SupportedProviderId {
	return providerId.trim().toLowerCase();
}

function normalizeGenericModelId(modelId: string): string | null {
	const separatorIndex = modelId.indexOf("/");
	if (separatorIndex < 0) {
		return modelId;
	}

	const parsedModelId = modelId.slice(separatorIndex + 1).trim();
	return parsedModelId.length > 0 ? parsedModelId : null;
}

export function normalizeModelId(
	modelId: string | undefined,
	providerId?: SupportedProviderId,
): string | null {
	if (typeof modelId !== "string") {
		return null;
	}

	const normalized = modelId.trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	const normalizedProviderId = providerId ? normalizeProviderId(providerId) : undefined;
	if (normalizedProviderId === BLAZEAPI_PROVIDER_ID) {
		return normalizeBlazeApiModelId(normalized);
	}

	return normalizeGenericModelId(normalized);
}

export function formatModelReference(
	providerId: SupportedProviderId,
	modelId: string,
): string {
	return `${normalizeProviderId(providerId)}/${modelId}`;
}

function isCodexGptModel(normalizedModelId: string): boolean {
	return normalizedModelId.startsWith("gpt-");
}

function isCodexFreeBlockedModel(normalizedModelId: string): boolean {
	return (
		OPENAI_CODEX_FREE_BLOCKED_MODEL_IDS.has(normalizedModelId) ||
		OPENAI_CODEX_FREE_BLOCKED_MODEL_PATTERNS.some((pattern) => pattern.test(normalizedModelId))
	);
}

/**
 * Normalizes Codex plan labels from usage snapshots.
 */
export function normalizeCodexPlanType(planType: string | null | undefined): CodexPlanType {
	if (typeof planType !== "string") {
		return "unknown";
	}

	const normalized = planType.trim().toLowerCase();
	if (!normalized) {
		return "unknown";
	}

	const collapsed = normalized.replace(/^chatgpt(?:[\s_-]+)?/, "").replace(/[\s_-]+/g, "-");
	switch (collapsed) {
		case "free":
		case "plus":
		case "pro":
		case "team":
		case "business":
		case "enterprise":
			return collapsed;
		default:
			return "unknown";
	}
}

/**
 * Indicates whether a model currently requires a paid Codex plan.
 */
export function modelRequiresEntitlement(
	providerId: SupportedProviderId,
	modelId: string | undefined,
): boolean {
	const normalizedProviderId = normalizeProviderId(providerId);
	if (normalizedProviderId === "openai-codex") {
		const normalizedModelId = normalizeModelId(modelId, normalizedProviderId);
		if (!normalizedModelId) {
			return false;
		}
		return isCodexFreeBlockedModel(normalizedModelId);
	}

	if (normalizedProviderId === BLAZEAPI_PROVIDER_ID) {
		const normalizedModelId = normalizeModelId(modelId, normalizedProviderId);
		if (!normalizedModelId) {
			return false;
		}
		return isBlazeApiPremiumChargingModel(normalizedModelId);
	}

	if (normalizedProviderId === KIRO_PROVIDER_ID) {
		const normalizedModelId = normalizeModelId(modelId, normalizedProviderId);
		if (!normalizedModelId) {
			return false;
		}
		return isKiroPaidPlanModel(normalizedModelId);
	}

	return false;
}

/**
 * Indicates whether eligible free-plan credentials should be prioritized for a model.
 *
 * Codex and Kiro use this to conserve paid quota when the requested model is
 * available on Free plans. BlazeAPI uses a richer tiered ranking instead (see
 * {@link rankBlazeApiCredentialsByPlanTier}).
 */
export function modelPrefersFreePlan(
	providerId: SupportedProviderId,
	modelId: string | undefined,
): boolean {
	const normalizedProviderId = normalizeProviderId(providerId);
	if (normalizedProviderId === "openai-codex") {
		const normalizedModelId = normalizeModelId(modelId, normalizedProviderId);
		return normalizedModelId !== null &&
			isCodexGptModel(normalizedModelId) &&
			!isCodexFreeBlockedModel(normalizedModelId);
	}

	if (normalizedProviderId === KIRO_PROVIDER_ID) {
		const normalizedModelId = normalizeModelId(modelId, normalizedProviderId);
		return normalizedModelId !== null && !isKiroPaidPlanModel(normalizedModelId);
	}

	return false;
}

/**
 * Indicates whether a provider routes credentials through a plan-tier ranking
 * during model selection. Returning `true` switches the eligibility resolver
 * onto the {@link CredentialModelEligibility.preferredCredentialTiers} path
 * (highest-tier-first with automatic fallback).
 */
export function providerUsesPlanTierRanking(providerId: SupportedProviderId): boolean {
	const normalizedProviderId = normalizeProviderId(providerId);
	return normalizedProviderId === BLAZEAPI_PROVIDER_ID || normalizedProviderId === KIRO_PROVIDER_ID;
}

/**
 * Checks if a Codex plan type is eligible for a paid model.
 */
export function isPlanEligibleForModel(planType: CodexPlanType): boolean {
	return OPENAI_CODEX_PAID_PLAN_TYPES.has(planType);
}

// ---------------------------------------------------------------------------
// BlazeAPI entitlement helpers
// ---------------------------------------------------------------------------

/**
 * BlazeAPI models that require a paid account at request time. The live
 * `/api/models` catalog can report `required_plan: "Free"` for these routes,
 * but `/api/chat/completions` still rejects Free API keys with
 * `paid_plan_required` (verified 2026-05-12 for `claude-opus-4.7`).
 */
const BLAZEAPI_PREMIUM_CHARGING_MODEL_IDS: ReadonlySet<string> = new Set([
	"claude-opus-4.6",
	"claude-opus-4.7",
	"kimi-k2.5-test",
	"moonshotai/kimi-k2.6",
	"qwen/qwen3.5-397b",
	"z-ai/glm-5.1",
]);

const BLAZEAPI_PREMIUM_CHARGING_MODEL_PATTERNS: readonly RegExp[] = [
	/^claude-opus-[\d.]+/,
	/^claude-sonnet-[\d.]+/,
];

/** BlazeAPI plan labels that have a non-zero `premium_daily_credits` budget. */
const BLAZEAPI_PREMIUM_CAPABLE_PLAN_TYPES: ReadonlySet<BlazeApiPlanType> = new Set<BlazeApiPlanType>([
	"pro",
	"premium",
]);

function normalizeBlazeApiModelId(modelId: string | undefined): string | null {
	if (typeof modelId !== "string") {
		return null;
	}
	const lowered = modelId.trim().toLowerCase();
	if (!lowered) {
		return null;
	}
	const withoutProvider = lowered.startsWith("blazeapi/") ? lowered.slice("blazeapi/".length) : lowered;
	return withoutProvider.length > 0 ? withoutProvider : null;
}

function isBlazeApiPremiumChargingModel(modelId: string): boolean {
	if (BLAZEAPI_PREMIUM_CHARGING_MODEL_IDS.has(modelId)) {
		return true;
	}
	return BLAZEAPI_PREMIUM_CHARGING_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * Normalizes BlazeAPI plan labels returned by `/api/usage` into a stable enum.
 * Unknown labels collapse to `"unknown"`.
 */
export function normalizeBlazeApiPlanType(
	planType: string | null | undefined,
): BlazeApiPlanType {
	if (typeof planType !== "string") {
		return "unknown";
	}

	const normalized = planType.trim().toLowerCase();
	if (!normalized) {
		return "unknown";
	}

	switch (normalized) {
		case "free":
			return "free";
		case "pro":
			return "pro";
		case "premium":
			return "premium";
		default:
			return "unknown";
	}
}

/**
 * Checks whether a BlazeAPI plan type has access to premium-charging models.
 * A plan is premium-capable when its `premium_daily_credits` budget is
 * non-zero, which on BlazeAPI corresponds to the `Pro` and `Premium` tiers.
 */
export function isBlazeApiPlanEligibleForPremiumModel(
	planType: BlazeApiPlanType,
): boolean {
	return BLAZEAPI_PREMIUM_CAPABLE_PLAN_TYPES.has(planType);
}

/**
 * BlazeAPI plan-tier ordering used for credential routing, highest priority
 * first. Higher plans receive faster server-side pool priority on BlazeAPI, so
 * we exhaust the highest tier before falling back to the next.
 */
const BLAZEAPI_PLAN_TIER_ORDER: readonly BlazeApiPlanType[] = [
	"premium",
	"pro",
	"free",
];

/**
 * Buckets BlazeAPI credentials into ordered plan-tier groups (`Premium` first,
 * then `Pro`, then `Free`) suitable for {@link
 * CredentialModelEligibility.preferredCredentialTiers}. Credentials whose plan
 * type is `unknown` are returned in a trailing tier so they are still tried as
 * a last resort but never preferred over a verified higher tier.
 */
export function rankBlazeApiCredentialsByPlanTier(
	credentialPlanTypes: ReadonlyMap<string, BlazeApiPlanType>,
): readonly (readonly string[])[] {
	return rankCredentialsByPlanTier(credentialPlanTypes, BLAZEAPI_PLAN_TIER_ORDER);
}

// ---------------------------------------------------------------------------
// Kiro entitlement helpers
// ---------------------------------------------------------------------------

/** Kiro models that require Pro, Pro+, or Power per https://kiro.dev/docs/models/. */
const KIRO_PAID_PLAN_MODEL_IDS: ReadonlySet<string> = new Set([
	"claude-haiku-4.5",
	"claude-opus-4.5",
	"claude-opus-4.6",
	"claude-opus-4.7",
	"claude-sonnet-4.6",
]);

const KIRO_PAID_PLAN_MODEL_PATTERNS: readonly RegExp[] = [
	/^claude-opus-[\d.]+$/,
];

const KIRO_PAID_CAPABLE_PLAN_TYPES: ReadonlySet<KiroPlanType> = new Set<KiroPlanType>([
	"pro",
	"pro-plus",
	"power",
]);

const KIRO_HIGH_TIER_FIRST_PLAN_ORDER: readonly KiroPlanType[] = [
	"power",
	"pro-plus",
	"pro",
	"free",
];

const KIRO_FREE_FIRST_PLAN_ORDER: readonly KiroPlanType[] = [
	"free",
	"power",
	"pro-plus",
	"pro",
];

function isKiroPaidPlanModel(modelId: string): boolean {
	if (KIRO_PAID_PLAN_MODEL_IDS.has(modelId)) {
		return true;
	}
	return KIRO_PAID_PLAN_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * Normalizes Kiro subscription labels from usage snapshots. The usage endpoint
 * has returned values like `KIRO FREE`; keep matching tolerant so future labels
 * such as `Kiro Pro Plus` still route to the right tier.
 */
export function normalizeKiroPlanType(planType: string | null | undefined): KiroPlanType {
	if (typeof planType !== "string") {
		return "unknown";
	}

	const normalized = planType.trim().toLowerCase();
	if (!normalized) {
		return "unknown";
	}

	const collapsed = normalized
		.replace(/^kiro(?:[\s_-]+)?/, "")
		.replace(/\bplan\b/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	switch (collapsed) {
		case "free":
			return "free";
		case "pro":
			return "pro";
		case "pro+":
		case "pro-plus":
			return "pro-plus";
		case "power":
			return "power";
		default:
			return "unknown";
	}
}

/** Checks whether a Kiro plan can access models hidden from Free accounts. */
export function isKiroPlanEligibleForPaidModel(planType: KiroPlanType): boolean {
	return KIRO_PAID_CAPABLE_PLAN_TYPES.has(planType);
}

export function rankKiroCredentialsByPlanTier(
	credentialPlanTypes: ReadonlyMap<string, KiroPlanType>,
	options: { preferFreeTier: boolean },
): readonly (readonly string[])[] {
	return rankCredentialsByPlanTier(
		credentialPlanTypes,
		options.preferFreeTier ? KIRO_FREE_FIRST_PLAN_ORDER : KIRO_HIGH_TIER_FIRST_PLAN_ORDER,
	);
}

function rankCredentialsByPlanTier<TPlan extends string>(
	credentialPlanTypes: ReadonlyMap<string, TPlan>,
	planOrder: readonly TPlan[],
): readonly (readonly string[])[] {
	const bucketByTier = new Map<TPlan, string[]>();
	for (const tier of planOrder) {
		bucketByTier.set(tier, []);
	}
	const unknownBucket: string[] = [];
	for (const [credentialId, planType] of credentialPlanTypes) {
		const bucket = bucketByTier.get(planType);
		if (bucket) {
			bucket.push(credentialId);
		} else {
			unknownBucket.push(credentialId);
		}
	}
	const tiers: string[][] = [];
	for (const tier of planOrder) {
		const bucket = bucketByTier.get(tier);
		if (bucket && bucket.length > 0) {
			tiers.push(bucket);
		}
	}
	if (unknownBucket.length > 0) {
		tiers.push(unknownBucket);
	}
	return tiers;
}
