import { fetchWithTimeout } from "../async-utils.js";
import { isRecord, normalizeNonEmptyString } from "../auth-error-utils.js";
import { quotaClassifier } from "../quota-classifier.js";
import type {
	RateLimitWindow,
	UsageAuth,
	UsageCredits,
	UsageProvider,
	UsageSnapshot,
} from "./types.js";

const BLAZEAPI_PROVIDER_ID = "blazeapi";
const BLAZEAPI_USAGE_BASE_URL = "https://blazeai.boxu.dev/api";
const BLAZEAPI_USAGE_PATH = "/usage";
const REQUEST_TIMEOUT_MS = 3_000;

interface BlazeApiUsageResponse {
	user?: unknown;
	plan?: unknown;
	usage?: unknown;
}

interface BlazeApiPlan {
	name: string | null;
	dailyRequests: number | null;
	rateLimitRpm: number | null;
	premiumDailyCredits: number | null;
	expiresAt: number | null;
}

interface BlazeApiDailyUsage {
	requests: number | null;
	credits: number | null;
	premiumCredits: number | null;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	if (!normalized) {
		return null;
	}
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 1_000_000_000_000 ? value : value * 1000;
	}
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	if (!normalized) {
		return null;
	}
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Returns the next UTC midnight in milliseconds.
 *
 * BlazeAPI quotas (`daily_requests`, `premium_daily_credits`) reset on a daily cadence
 * which the `/api/usage` endpoint does not surface explicitly, but the `daily_breakdown`
 * uses UTC-aligned `YYYY-MM-DDT00:00:00.000Z` buckets, so we estimate the boundary at
 * the next UTC 00:00.
 */
function getNextUtcMidnightMs(now: number): number {
	const date = new Date(now);
	return Date.UTC(
		date.getUTCFullYear(),
		date.getUTCMonth(),
		date.getUTCDate() + 1,
		0,
		0,
		0,
		0,
	);
}

const DAILY_WINDOW_MINUTES = 24 * 60;

function normalizeBaseUrl(auth: UsageAuth): string {
	const requestConfig = isRecord(auth.credential?.request) ? auth.credential.request : null;
	const configuredBaseUrl = normalizeNonEmptyString(requestConfig?.baseUrl);
	const baseUrl = configuredBaseUrl ?? BLAZEAPI_USAGE_BASE_URL;
	// Strip OpenAI-compat suffixes that may appear when the credential reuses the chat endpoint
	// (e.g. `https://blazeai.boxu.dev/api/v1/chat/completions`) and trim trailing slashes.
	return baseUrl
		.replace(/\/chat\/completions\/?$/i, "")
		.replace(/\/v1\/?$/i, "")
		.replace(/\/+$/, "");
}

function parsePlan(value: unknown): BlazeApiPlan {
	const record = isRecord(value) ? value : null;
	return {
		name: normalizeNonEmptyString(record?.name) ?? null,
		dailyRequests: asNumber(record?.daily_requests),
		rateLimitRpm: asNumber(record?.rate_limit_rpm),
		premiumDailyCredits: asNumber(record?.premium_daily_credits),
		expiresAt: parseTimestamp(record?.expires_at),
	};
}

/**
 * Parses the `usage.today` counters.
 *
 * The `/api/usage` endpoint returns a structured object:
 *   { requests, credits, premium_credits }
 *
 * For forward-compatibility with the legacy `/api/account` shape (where the same
 * counters are flattened siblings of `usage.today`), this also accepts a numeric
 * `today` value and reads `premium_used` off the same parent record.
 */
function parseDailyUsage(usage: unknown): BlazeApiDailyUsage {
	if (!isRecord(usage)) {
		return { requests: null, credits: null, premiumCredits: null };
	}

	const today = usage.today;
	if (isRecord(today)) {
		return {
			requests: asNumber(today.requests),
			credits: asNumber(today.credits),
			premiumCredits: asNumber(today.premium_credits),
		};
	}

	// Legacy flat shape: usage.today is the request count and premium consumption
	// is reported as `usage.premium_used` on the same record.
	const flatRequests = asNumber(today);
	if (flatRequests !== null) {
		return {
			requests: flatRequests,
			credits: asNumber(usage.global),
			premiumCredits: asNumber(usage.premium_used),
		};
	}

	return { requests: null, credits: null, premiumCredits: null };
}

function buildPrimaryWindow(
	plan: BlazeApiPlan,
	daily: BlazeApiDailyUsage,
	resetsAt: number,
): RateLimitWindow | null {
	if (plan.dailyRequests === null || plan.dailyRequests <= 0) {
		return null;
	}
	const used = Math.max(0, daily.requests ?? 0);
	return {
		usedPercent: clampPercent((used / plan.dailyRequests) * 100),
		windowMinutes: DAILY_WINDOW_MINUTES,
		resetsAt,
	};
}

function buildSecondaryWindow(
	plan: BlazeApiPlan,
	daily: BlazeApiDailyUsage,
	resetsAt: number,
): RateLimitWindow | null {
	if (plan.premiumDailyCredits === null || plan.premiumDailyCredits <= 0) {
		return null;
	}
	const used = Math.max(0, daily.premiumCredits ?? 0);
	return {
		usedPercent: clampPercent((used / plan.premiumDailyCredits) * 100),
		windowMinutes: DAILY_WINDOW_MINUTES,
		resetsAt,
	};
}

function buildUsageCredits(plan: BlazeApiPlan, daily: BlazeApiDailyUsage): UsageCredits | null {
	if (plan.premiumDailyCredits === null) {
		return null;
	}
	if (plan.premiumDailyCredits <= 0) {
		return {
			hasCredits: false,
			unlimited: false,
			balance: "0 premium credits/day",
		};
	}
	const used = Math.max(0, daily.premiumCredits ?? 0);
	const remaining = Math.max(0, plan.premiumDailyCredits - used);
	const remainingDisplay = Number.isInteger(remaining) ? remaining.toString() : remaining.toFixed(1);
	return {
		hasCredits: remaining > 0,
		unlimited: false,
		balance: `${remainingDisplay} premium credits left today`,
	};
}

function formatPlanType(plan: BlazeApiPlan): string | null {
	if (!plan.name) {
		return null;
	}
	// Plan names from BlazeAPI are already user-facing labels (e.g. "Free", "Pro").
	return plan.name;
}

function parseUsageResponse(value: unknown): BlazeApiUsageResponse | null {
	if (!isRecord(value)) {
		return null;
	}
	return value as BlazeApiUsageResponse;
}

/**
 * Fetches BlazeAPI account, plan, and usage information from `GET /api/usage`.
 *
 * Verified live against `https://blazeai.boxu.dev/api/usage` with an
 * `Authorization: Bearer blz_*` API key. The endpoint returns daily request and
 * credit counters, premium credit consumption, the active plan and limits, the
 * past-week daily breakdown, and recent request history. We translate the daily
 * counters into the shared `RateLimitWindow` shape so the multi-auth modal can
 * render them alongside other providers.
 *
 * Note: the cookie-gated `/api/account` endpoint visible in the browser HAR
 * cannot be used here — it returns `{"signed_in": false}` for Bearer auth.
 */
export const blazeapiUsageProvider: UsageProvider<UsageAuth> = {
	id: BLAZEAPI_PROVIDER_ID,
	displayName: "BlazeAPI",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		if (!auth.accessToken) {
			return null;
		}

		const response = await fetchWithTimeout(
			`${normalizeBaseUrl(auth)}${BLAZEAPI_USAGE_PATH}`,
			{
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${auth.accessToken}`,
					"User-Agent": "pi-multi-auth",
				},
			},
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: `BlazeAPI usage request timed out after ${REQUEST_TIMEOUT_MS}ms`,
			},
		);

		if (response.status === 401) {
			throw new Error("BlazeAPI token expired or invalid");
		}
		if (response.status === 403) {
			throw new Error("BlazeAPI usage access was denied for this account");
		}
		if (!response.ok) {
			throw new Error(`BlazeAPI usage request failed with status ${response.status}`);
		}

		const parsed = parseUsageResponse((await response.json()) as unknown);
		if (!parsed) {
			throw new Error("BlazeAPI usage response format was invalid");
		}

		const plan = parsePlan(parsed.plan);
		const daily = parseDailyUsage(parsed.usage);
		if (plan.dailyRequests === null && plan.premiumDailyCredits === null) {
			throw new Error("BlazeAPI usage response did not include plan limits");
		}

		const now = Date.now();
		const resetsAt = getNextUtcMidnightMs(now);
		const primary = buildPrimaryWindow(plan, daily, resetsAt);
		const secondary = buildSecondaryWindow(plan, daily, resetsAt);
		const credits = buildUsageCredits(plan, daily);
		const quotaClassification = quotaClassifier.classifyFromUsage(primary, secondary).classification;

		return {
			timestamp: now,
			provider: BLAZEAPI_PROVIDER_ID,
			planType: formatPlanType(plan),
			primary,
			secondary,
			credits,
			copilotQuota: null,
			updatedAt: now,
			estimatedResetAt: resetsAt,
			quotaClassification,
		};
	},
};
