import { fetchWithTimeout } from "../async-utils.js";
import { isRecord, normalizeNonEmptyString } from "../auth-error-utils.js";
import { quotaClassifier } from "../quota-classifier.js";
import type { RateLimitWindow, UsageAuth, UsageProvider, UsageSnapshot } from "./types.js";

const KIMI_CODING_PROVIDER_ID = "kimi-coding";
const KIMI_CODING_USAGE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CODING_USAGE_PATH = "usages";
const REQUEST_TIMEOUT_MS = 3_000;

interface KimiUsagePayload {
	usage?: unknown;
	limits?: unknown;
}

interface KimiUsageRow {
	usedPercent: number;
	windowMinutes: number | null;
	resetsAt: number | null;
	windowSortMinutes: number | null;
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

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeBaseUrl(auth: UsageAuth): string {
	const requestConfig = isRecord(auth.credential?.request) ? auth.credential.request : null;
	const configuredBaseUrl = normalizeNonEmptyString(requestConfig?.baseUrl);
	return (configuredBaseUrl ?? KIMI_CODING_USAGE_BASE_URL).replace(/\/+$/, "");
}

function parseWindowMinutes(value: unknown): number | null {
	if (!isRecord(value)) {
		return null;
	}

	const duration = asNumber(value.duration);
	const timeUnit = normalizeNonEmptyString(value.timeUnit)?.toLowerCase();
	if (duration === null || duration <= 0 || !timeUnit) {
		return null;
	}
	if (timeUnit.includes("minute")) {
		return Math.round(duration);
	}
	if (timeUnit.includes("hour")) {
		return Math.round(duration * 60);
	}
	if (timeUnit.includes("day")) {
		return Math.round(duration * 24 * 60);
	}
	if (timeUnit.includes("second")) {
		return Math.max(1, Math.round(duration / 60));
	}
	return null;
}

function parseResetAt(value: unknown, now: number): number | null {
	if (!isRecord(value)) {
		return null;
	}

	for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"] as const) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) {
			const parsed = Date.parse(candidate);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate > 1_000_000_000_000 ? candidate : candidate * 1000;
		}
	}

	for (const key of ["reset_in", "resetIn", "ttl"] as const) {
		const seconds = asNumber(value[key]);
		if (seconds !== null && seconds >= 0) {
			return now + seconds * 1000;
		}
	}

	return null;
}

function buildUsageWindow(row: KimiUsageRow): RateLimitWindow {
	return {
		usedPercent: row.usedPercent,
		windowMinutes: row.windowMinutes,
		resetsAt: row.resetsAt,
	};
}

function parseUsageRow(
	value: unknown,
	window: unknown,
	now: number,
): KimiUsageRow | null {
	if (!isRecord(value)) {
		return null;
	}

	const limit = asNumber(value.limit);
	const remaining = asNumber(value.remaining);
	let used = asNumber(value.used);
	if (used === null && limit !== null && remaining !== null) {
		used = limit - remaining;
	}
	if (limit === null || limit <= 0 || used === null) {
		return null;
	}

	const windowMinutes = parseWindowMinutes(window);
	const resetsAt = parseResetAt(value, now) ?? parseResetAt(window, now);
	return {
		usedPercent: clampPercent((used / limit) * 100),
		windowMinutes,
		resetsAt,
		windowSortMinutes: windowMinutes,
	};
}

function parseUsagePayload(value: unknown, now: number): KimiUsageRow[] {
	if (!isRecord(value)) {
		return [];
	}

	const payload = value as KimiUsagePayload;
	const rows: KimiUsageRow[] = [];
	const summaryRow = parseUsageRow(payload.usage, undefined, now);
	if (summaryRow) {
		rows.push(summaryRow);
	}

	if (!Array.isArray(payload.limits)) {
		return rows;
	}

	for (const item of payload.limits) {
		if (!isRecord(item)) {
			continue;
		}
		const detail = isRecord(item.detail) ? item.detail : item;
		const row = parseUsageRow(detail, item.window, now);
		if (row) {
			rows.push(row);
		}
	}

	return rows;
}

function selectUsageWindows(rows: readonly KimiUsageRow[]): {
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
} {
	const timedRows = rows
		.filter((row) => row.windowSortMinutes !== null)
		.sort((left, right) => (left.windowSortMinutes ?? Number.MAX_SAFE_INTEGER) - (right.windowSortMinutes ?? Number.MAX_SAFE_INTEGER));
	const untimedRows = rows.filter((row) => row.windowSortMinutes === null);
	const selected = [...timedRows, ...untimedRows].slice(0, 2);
	return {
		primary: selected[0] ? buildUsageWindow(selected[0]) : null,
		secondary: selected[1] ? buildUsageWindow(selected[1]) : null,
	};
}

function getEstimatedResetAt(primary: RateLimitWindow | null, secondary: RateLimitWindow | null): number | undefined {
	const resets = [primary?.resetsAt, secondary?.resetsAt].filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value),
	);
	if (resets.length === 0) {
		return undefined;
	}
	return Math.min(...resets);
}

/**
 * Fetches Kimi Coding quota windows from the documented /usages endpoint.
 */
export const kimiCodingUsageProvider: UsageProvider<UsageAuth> = {
	id: KIMI_CODING_PROVIDER_ID,
	displayName: "Kimi For Coding",
	fetchUsage: async (auth: UsageAuth): Promise<UsageSnapshot | null> => {
		if (!auth.accessToken) {
			return null;
		}

		const response = await fetchWithTimeout(
			`${normalizeBaseUrl(auth)}/${KIMI_CODING_USAGE_PATH}`,
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
				timeoutMessage: `Kimi Coding usage request timed out after ${REQUEST_TIMEOUT_MS}ms`,
			},
		);

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error("Kimi Coding token expired or invalid");
			}
			if (response.status === 403) {
				throw new Error("Kimi Coding usage access was denied for this account");
			}
			throw new Error(`Kimi Coding usage request failed with status ${response.status}`);
		}

		const now = Date.now();
		const rows = parseUsagePayload((await response.json()) as unknown, now);
		if (rows.length === 0) {
			throw new Error("Kimi Coding usage response format was invalid");
		}

		const { primary, secondary } = selectUsageWindows(rows);
		const quotaClassification = quotaClassifier.classifyFromUsage(primary, secondary).classification;
		return {
			timestamp: now,
			provider: KIMI_CODING_PROVIDER_ID,
			planType: null,
			primary,
			secondary,
			credits: null,
			copilotQuota: null,
			updatedAt: now,
			estimatedResetAt: getEstimatedResetAt(primary, secondary),
			quotaClassification,
		};
	},
};
