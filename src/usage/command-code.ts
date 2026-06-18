import { fetchWithTimeout } from "../async-utils.js";
import { isRecord, normalizeNonEmptyString } from "../auth-error-utils.js";
import { quotaClassifier } from "../quota-classifier.js";
import type { RateLimitWindow, UsageAuth, UsageCredits, UsageProvider, UsageSnapshot } from "./types.js";

const COMMAND_CODE_PROVIDER_ID = "command-code";
const COMMAND_CODE_USAGE_BASE_URL = "https://api.commandcode.ai";
const COMMAND_CODE_CLI_VERSION = "0.25.1";
const REQUEST_TIMEOUT_MS = 3_000;

const PLAN_TYPE_MAP: Record<string, string> = {
	"individual-go": "CommandCode Go",
	"individual-pro": "CommandCode Pro",
	"individual-max": "CommandCode Max",
	"individual-ultra": "CommandCode Ultra",
	"teams-pro": "CommandCode Teams Pro",
};

const PLAN_CREDIT_TOTALS: Record<string, number> = {
	"individual-go": 10,
	"individual-pro": 30,
	"individual-max": 150,
	"individual-ultra": 300,
	"teams-pro": 40,
};

interface CommandCodeFetchOptions {
	baseUrl: string;
	accessToken: string;
}

interface CommandCodeUsageData {
	whoami: Record<string, unknown> | null;
	credits: Record<string, unknown> | null;
	subscription: Record<string, unknown> | null;
	summary: Record<string, unknown> | null;
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

function normalizeBaseUrl(auth: UsageAuth): string {
	const requestConfig = isRecord(auth.credential?.request) ? auth.credential.request : null;
	const configuredBaseUrl = normalizeNonEmptyString(requestConfig?.baseUrl);
	const baseUrl = configuredBaseUrl ?? COMMAND_CODE_USAGE_BASE_URL;
	return baseUrl
		.replace(/\/alpha\/generate\/?$/i, "")
		.replace(/\/alpha\/?$/i, "")
		.replace(/\/+$/, "");
}

function buildEndpoint(path: string, params?: Record<string, string | null>): string {
	const searchParams = new URLSearchParams();
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value) {
			searchParams.set(key, value);
		}
	}
	const query = searchParams.toString();
	return query ? `${path}?${query}` : path;
}

function getNestedRecord(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
	const nested = value?.[key];
	return isRecord(nested) ? nested : null;
}

function unwrapApiData(value: Record<string, unknown> | null): Record<string, unknown> | null {
	return getNestedRecord(value, "data") ?? value;
}

function getOrgId(whoami: Record<string, unknown> | null): string | null {
	const payload = unwrapApiData(whoami);
	const org = getNestedRecord(payload, "org");
	return normalizeNonEmptyString(org?.id) ?? null;
}

function getSubscriptionData(subscription: Record<string, unknown> | null): Record<string, unknown> | null {
	return unwrapApiData(subscription);
}

function formatPlanType(planId: string | null): string | null {
	if (!planId) {
		return null;
	}
	const normalized = planId.trim().toLowerCase().replace(/_/g, "-");
	return PLAN_TYPE_MAP[normalized] ?? planId;
}

function parseDateMillis(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 1_000_000_000_000 ? value : value * 1000;
	}
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function getWindowMinutes(startAt: number | null, endAt: number | null): number | null {
	if (startAt === null || endAt === null || endAt <= startAt) {
		return null;
	}
	return Math.max(1, Math.round((endAt - startAt) / 60_000));
}

function getCreditBalance(credits: Record<string, unknown> | null): number | null {
	const payload = unwrapApiData(credits);
	const creditBuckets = getNestedRecord(payload, "credits") ?? payload;
	if (!creditBuckets) {
		return null;
	}
	const monthlyCredits = asNumber(creditBuckets.monthlyCredits) ?? 0;
	const purchasedCredits = asNumber(creditBuckets.purchasedCredits) ?? 0;
	const freeCredits = asNumber(creditBuckets.freeCredits) ?? 0;
	const total = monthlyCredits + purchasedCredits + freeCredits;
	return Number.isFinite(total) ? Math.max(0, total) : null;
}

function getSummaryTotalCost(summary: Record<string, unknown> | null): number | null {
	const payload = unwrapApiData(summary);
	const totalCost = asNumber(payload?.totalCost);
	return totalCost === null ? null : Math.max(0, totalCost);
}

function buildUsageCredits(remainingCredits: number | null): UsageCredits | null {
	if (remainingCredits === null) {
		return null;
	}
	return {
		hasCredits: remainingCredits > 0,
		unlimited: false,
		balance: `$${remainingCredits.toFixed(2)} left`,
	};
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function buildPrimaryWindow(
	remainingCredits: number | null,
	usedCredits: number | null,
	subscriptionData: Record<string, unknown> | null,
	planId: string | null,
): RateLimitWindow | null {
	if (usedCredits === null && remainingCredits === null) {
		return null;
	}

	const knownUsedCredits = usedCredits ?? 0;
	const planTotal = planId ? PLAN_CREDIT_TOTALS[planId] : undefined;
	const totalCredits = remainingCredits !== null
		? knownUsedCredits + remainingCredits
		: typeof planTotal === "number"
			? planTotal
			: null;
	if (totalCredits === null || totalCredits <= 0) {
		return null;
	}

	const startAt = parseDateMillis(subscriptionData?.currentPeriodStart);
	const endAt = parseDateMillis(subscriptionData?.currentPeriodEnd);
	return {
		usedPercent: clampPercent((knownUsedCredits / totalCredits) * 100),
		windowMinutes: getWindowMinutes(startAt, endAt),
		resetsAt: endAt,
	};
}

async function fetchCommandCodeJson(
	endpoint: string,
	options: CommandCodeFetchOptions,
): Promise<Record<string, unknown> | null> {
	const response = await fetchWithTimeout(
		`${options.baseUrl}${endpoint}`,
		{
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${options.accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": "pi-multi-auth",
				"x-cli-environment": "production",
				"x-command-code-version": COMMAND_CODE_CLI_VERSION,
			},
		},
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: `CommandCode usage request timed out after ${REQUEST_TIMEOUT_MS}ms`,
		},
	);

	if (response.status === 401) {
		throw new Error("CommandCode token expired or invalid");
	}
	if (response.status === 403) {
		throw new Error("CommandCode usage access was denied for this account");
	}
	if (!response.ok) {
		throw new Error(`CommandCode usage request failed with status ${response.status}`);
	}

	const payload = (await response.json()) as unknown;
	return isRecord(payload) ? payload : null;
}

async function fetchCommandCodeUsageData(auth: UsageAuth): Promise<CommandCodeUsageData> {
	const baseUrl = normalizeBaseUrl(auth);
	const requestOptions = { baseUrl, accessToken: auth.accessToken };
	const whoami = await fetchCommandCodeJson("/alpha/whoami", requestOptions);
	const orgId = getOrgId(whoami);
	const [credits, subscription] = await Promise.all([
		fetchCommandCodeJson(buildEndpoint("/alpha/billing/credits", { orgId }), requestOptions),
		fetchCommandCodeJson(buildEndpoint("/alpha/billing/subscriptions", { orgId }), requestOptions),
	]);
	const subscriptionData = getSubscriptionData(subscription);
	const since = normalizeNonEmptyString(subscriptionData?.currentPeriodStart) ?? null;
	const summary = await fetchCommandCodeJson(
		buildEndpoint("/alpha/usage/summary", { orgId, since }),
		requestOptions,
	);
	return { whoami, credits, subscription, summary };
}

/**
 * Fetches CommandCode credit and billing-cycle usage from the CLI's alpha endpoints.
 */
export const commandCodeUsageProvider: UsageProvider<UsageAuth> = {
	id: COMMAND_CODE_PROVIDER_ID,
	displayName: "CommandCode",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		if (!auth.accessToken) {
			return null;
		}

		const data = await fetchCommandCodeUsageData(auth);
		const subscriptionData = getSubscriptionData(data.subscription);
		const rawPlanId = normalizeNonEmptyString(subscriptionData?.planId);
		const planId = rawPlanId?.toLowerCase().replace(/_/g, "-") ?? null;
		const remainingCredits = getCreditBalance(data.credits);
		const usedCredits = getSummaryTotalCost(data.summary);
		const primary = buildPrimaryWindow(remainingCredits, usedCredits, subscriptionData, planId);
		if (!primary && remainingCredits === null) {
			throw new Error("CommandCode usage response format was invalid");
		}

		const quotaClassification = quotaClassifier.classifyFromUsage(primary, null).classification;
		const now = Date.now();
		return {
			timestamp: now,
			provider: COMMAND_CODE_PROVIDER_ID,
			planType: formatPlanType(rawPlanId ?? null),
			primary,
			secondary: null,
			credits: buildUsageCredits(remainingCredits),
			copilotQuota: null,
			updatedAt: now,
			estimatedResetAt: primary?.resetsAt ?? undefined,
			quotaClassification,
		};
	},
};
