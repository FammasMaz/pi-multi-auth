import { fetchWithTimeout } from "../async-utils.js";
import { isRecord, normalizeNonEmptyString } from "../auth-error-utils.js";
import { quotaClassifier } from "../quota-classifier.js";
import type { RateLimitWindow, UsageAuth, UsageCredits, UsageProvider, UsageSnapshot } from "./types.js";

const KIRO_PROVIDER_ID = "kiro";
const KIRO_USAGE_ENDPOINT = "https://q.us-east-1.amazonaws.com/";
const KIRO_USAGE_TARGET = "AmazonCodeWhispererService.GetUsageLimits";
const KIRO_SDK_USER_AGENT = "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0";
const KIRO_AMZ_USER_AGENT = "aws-sdk-js/3.0.0 kiro-ide/1.0.0";
const REQUEST_TIMEOUT_MS = 3_000;

interface KiroUsageBreakdown {
	resourceType?: unknown;
	displayName?: unknown;
	displayNamePlural?: unknown;
	unit?: unknown;
	currency?: unknown;
	currentUsage?: unknown;
	currentUsageWithPrecision?: unknown;
	usageLimit?: unknown;
	usageLimitWithPrecision?: unknown;
	nextDateReset?: unknown;
}

interface KiroUsageLimitsResponse {
	nextDateReset?: unknown;
	subscriptionInfo?: Record<string, unknown>;
	usageBreakdownList?: unknown;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value !== "string") {
		return null;
	}
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : null;
}

function normalizePlanLabel(value: unknown): string | null {
	const raw = normalizeNonEmptyString(value);
	if (!raw) {
		return null;
	}

	const normalized = raw.toLowerCase().replace(/[\s_-]+/g, "-");
	if (normalized === "free" || normalized === "starter") {
		return "Free";
	}
	if (normalized === "pro" || normalized === "professional") {
		return "Pro";
	}
	if (normalized === "team" || normalized === "teams") {
		return "Team";
	}
	if (normalized === "business") {
		return "Business";
	}
	if (normalized === "enterprise") {
		return "Enterprise";
	}
	return raw;
}

function getStoredPlanType(auth: UsageAuth): string | null {
	return normalizePlanLabel(auth.credential?.planType) ??
		normalizePlanLabel(auth.credential?.plan) ??
		normalizePlanLabel(auth.credential?.subscriptionType) ??
		normalizePlanLabel(auth.credential?.subscriptionTier) ??
		normalizePlanLabel(auth.credential?.tier) ??
		normalizePlanLabel(auth.credential?.accountType);
}

function parseTimestampMillis(value: unknown): number | null {
	const raw = asNumber(value);
	if (raw === null || raw <= 0) {
		return null;
	}
	return raw > 1_000_000_000_000 ? Math.round(raw) : Math.round(raw * 1000);
}

function parseUsagePayload(payload: unknown): KiroUsageLimitsResponse | null {
	if (!isRecord(payload)) {
		return null;
	}
	return {
		nextDateReset: payload.nextDateReset,
		subscriptionInfo: isRecord(payload.subscriptionInfo) ? payload.subscriptionInfo : undefined,
		usageBreakdownList: payload.usageBreakdownList,
	};
}

function getUsageBreakdowns(payload: KiroUsageLimitsResponse): KiroUsageBreakdown[] {
	if (!Array.isArray(payload.usageBreakdownList)) {
		return [];
	}
	return payload.usageBreakdownList.filter(isRecord);
}

function getPlanType(auth: UsageAuth, payload: KiroUsageLimitsResponse): string | null {
	const subscriptionInfo = payload.subscriptionInfo;
	return normalizePlanLabel(subscriptionInfo?.subscriptionTitle) ??
		normalizePlanLabel(subscriptionInfo?.type) ??
		getStoredPlanType(auth);
}

function getUsageValue(breakdown: KiroUsageBreakdown): number | null {
	return asNumber(breakdown.currentUsageWithPrecision) ?? asNumber(breakdown.currentUsage);
}

function getUsageLimit(breakdown: KiroUsageBreakdown): number | null {
	return asNumber(breakdown.usageLimitWithPrecision) ?? asNumber(breakdown.usageLimit);
}

function getWindowMinutes(resetsAt: number | null): number | null {
	if (resetsAt === null) {
		return null;
	}
	const remainingMs = resetsAt - Date.now();
	return remainingMs > 0 ? Math.max(1, Math.round(remainingMs / 60_000)) : null;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function buildPrimaryWindow(breakdown: KiroUsageBreakdown | undefined, fallbackResetAt: number | null): RateLimitWindow | null {
	if (!breakdown) {
		return null;
	}
	const used = getUsageValue(breakdown);
	const limit = getUsageLimit(breakdown);
	if (used === null || limit === null || limit <= 0) {
		return null;
	}
	const resetsAt = parseTimestampMillis(breakdown.nextDateReset) ?? fallbackResetAt;
	return {
		usedPercent: clampPercent((used / limit) * 100),
		windowMinutes: getWindowMinutes(resetsAt),
		resetsAt,
	};
}

function buildCredits(breakdown: KiroUsageBreakdown | undefined): UsageCredits | null {
	if (!breakdown) {
		return null;
	}
	const used = getUsageValue(breakdown);
	const limit = getUsageLimit(breakdown);
	if (used === null || limit === null || limit <= 0) {
		return null;
	}
	const remaining = Math.max(0, limit - used);
	const unit = normalizeNonEmptyString(breakdown.unit) ?? normalizeNonEmptyString(breakdown.displayNamePlural) ?? "credits";
	return {
		hasCredits: remaining > 0,
		unlimited: false,
		balance: `${remaining.toFixed(2)} ${unit} left`,
	};
}

async function fetchKiroUsageLimits(accessToken: string): Promise<KiroUsageLimitsResponse> {
	const response = await fetchWithTimeout(
		KIRO_USAGE_ENDPOINT,
		{
			method: "POST",
			headers: {
				Accept: "application/x-amz-json-1.0",
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/x-amz-json-1.0",
				"User-Agent": KIRO_SDK_USER_AGENT,
				"X-Amz-Target": KIRO_USAGE_TARGET,
				"X-Amz-User-Agent": KIRO_AMZ_USER_AGENT,
			},
			body: "{}",
		},
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: `Kiro usage request timed out after ${REQUEST_TIMEOUT_MS}ms`,
		},
	);

	if (response.status === 401) {
		throw new Error("Kiro token expired or invalid");
	}
	if (response.status === 403) {
		throw new Error("Kiro usage access was denied for this account");
	}
	if (!response.ok) {
		throw new Error(`Kiro usage request failed with status ${response.status}`);
	}

	const parsed = parseUsagePayload(await response.json());
	if (!parsed) {
		throw new Error("Kiro usage response format was invalid");
	}
	return parsed;
}

export const kiroUsageProvider: UsageProvider<UsageAuth> = {
	id: KIRO_PROVIDER_ID,
	displayName: "Kiro",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		if (!auth.accessToken) {
			return null;
		}

		const payload = await fetchKiroUsageLimits(auth.accessToken);
		const breakdowns = getUsageBreakdowns(payload);
		const primaryBreakdown = breakdowns[0];
		const fallbackResetAt = parseTimestampMillis(payload.nextDateReset);
		const primary = buildPrimaryWindow(primaryBreakdown, fallbackResetAt);
		const credits = buildCredits(primaryBreakdown);
		if (!primary && !credits) {
			throw new Error("Kiro usage response format was invalid");
		}

		const quotaClassification = quotaClassifier.classifyFromUsage(primary, null).classification;
		const now = Date.now();
		return {
			timestamp: now,
			provider: KIRO_PROVIDER_ID,
			planType: getPlanType(auth, payload),
			primary,
			secondary: null,
			credits,
			copilotQuota: null,
			updatedAt: now,
			estimatedResetAt: primary?.resetsAt ?? fallbackResetAt ?? undefined,
			quotaClassification,
		};
	},
};
