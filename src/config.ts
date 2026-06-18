import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getErrorMessage } from "./auth-error-utils.js";
import type { RotationMode } from "./types.js";
import { DEFAULT_CASCADE_CONFIG, type CascadeConfig } from "./types-cascade.js";
import {
	DEFAULT_HEALTH_CONFIG,
	DEFAULT_HEALTH_WEIGHTS,
	type HealthMetricsConfig,
	type HealthScoreWeights,
} from "./types-health.js";
import { DEFAULT_OAUTH_CONFIG, type OAuthRefreshConfig } from "./types-oauth.js";
import {
	DEFAULT_USAGE_COORDINATION_CONFIG,
	type UsageCoordinationConfig,
} from "./usage/usage-coordinator.js";

export const MULTI_AUTH_EXTENSION_ID = "pi-multi-auth";

export interface HistoryPersistenceConfig {
	enabled: boolean;
	healthFileName: string;
	cascadeFileName: string;
}

export type CodexUsageLookupFailureMode = "strict" | "allow-unverified";

export interface CodexModelEntitlementConfig {
	usageLookupFailureMode: CodexUsageLookupFailureMode;
}

export interface ModelEntitlementConfig {
	codex: CodexModelEntitlementConfig;
}

export interface StreamTimeoutConfig {
	/** Maximum wall-clock duration for one provider attempt. 0 disables the attempt watchdog. */
	attemptTimeoutMs: number;
	/** Maximum time between provider stream events. 0 disables the idle watchdog. */
	idleTimeoutMs: number;
}

/** Per-provider partial overrides merged with streamTimeouts. */
export type ProviderStreamTimeoutOverrides = Record<string, Partial<StreamTimeoutConfig>>;

export interface CredentialRotationConfig {
	/** When true (default), dead OAuth / reauth failures disable credentials until re-enabled. */
	autoDisableBrokenCredentials: boolean;
}

export interface MultiAuthExtensionConfig {
	debug: boolean;
	/** Providers hidden from pi-multi-auth UI and runtime work. */
	hiddenProviders: string[];
	/** Provider rotation-mode overrides saved in config.json. */
	rotationModes: Record<string, RotationMode>;
	/** Legacy: providers excluded from rotation (merged into hiddenProviders on load). */
	excludeProviders: string[];
	/** Providers that never get quota/transient cooldowns (still rotate on hard failures). */
	noCooldownProviders: string[];
	/** Providers with no stream attempt/idle watchdogs (0 = disabled). */
	noStreamWatchdogProviders: string[];
	cascade: CascadeConfig;
	health: HealthMetricsConfig;
	historyPersistence: HistoryPersistenceConfig;
	modelEntitlements: ModelEntitlementConfig;
	oauthRefresh: OAuthRefreshConfig;
	usageCoordination: UsageCoordinationConfig;
	streamTimeouts: StreamTimeoutConfig;
	/** Per-provider stream watchdog overrides (partial fields merge with streamTimeouts). */
	providerStreamTimeouts: ProviderStreamTimeoutOverrides;
	credentialRotation: CredentialRotationConfig;
}

export interface MultiAuthConfigLoadResult {
	config: MultiAuthExtensionConfig;
	created: boolean;
	warning?: string;
}

export const DEFAULT_HISTORY_PERSISTENCE_CONFIG: HistoryPersistenceConfig = {
	enabled: true,
	healthFileName: `${MULTI_AUTH_EXTENSION_ID}-health-history.json`,
	cascadeFileName: `${MULTI_AUTH_EXTENSION_ID}-cascade-history.json`,
};

export const DEFAULT_CODEX_MODEL_ENTITLEMENT_CONFIG: CodexModelEntitlementConfig = {
	usageLookupFailureMode: "allow-unverified",
};

export const DEFAULT_MODEL_ENTITLEMENT_CONFIG: ModelEntitlementConfig = {
	codex: { ...DEFAULT_CODEX_MODEL_ENTITLEMENT_CONFIG },
};

export const DEFAULT_STREAM_TIMEOUT_CONFIG: StreamTimeoutConfig = {
	attemptTimeoutMs: 600_000,
	idleTimeoutMs: 45_000,
};

export const DEFAULT_CREDENTIAL_ROTATION_CONFIG: CredentialRotationConfig = {
	autoDisableBrokenCredentials: true,
};

export function cloneOAuthRefreshConfig(
	config: OAuthRefreshConfig = DEFAULT_OAUTH_CONFIG,
): OAuthRefreshConfig {
	return {
		...config,
		excludedProviders: [...config.excludedProviders],
	};
}

export const DEFAULT_MULTI_AUTH_CONFIG: MultiAuthExtensionConfig = {
	debug: false,
	hiddenProviders: [],
	rotationModes: {},
	excludeProviders: [],
	noCooldownProviders: ["LiteLLM"],
	noStreamWatchdogProviders: ["LiteLLM"],
	cascade: { ...DEFAULT_CASCADE_CONFIG },
	health: {
		...DEFAULT_HEALTH_CONFIG,
		weights: { ...DEFAULT_HEALTH_WEIGHTS },
	},
	historyPersistence: { ...DEFAULT_HISTORY_PERSISTENCE_CONFIG },
	modelEntitlements: cloneModelEntitlementConfig(DEFAULT_MODEL_ENTITLEMENT_CONFIG),
	oauthRefresh: cloneOAuthRefreshConfig(DEFAULT_OAUTH_CONFIG),
	usageCoordination: { ...DEFAULT_USAGE_COORDINATION_CONFIG },
	streamTimeouts: { ...DEFAULT_STREAM_TIMEOUT_CONFIG },
	providerStreamTimeouts: {} as ProviderStreamTimeoutOverrides,
	credentialRotation: { ...DEFAULT_CREDENTIAL_ROTATION_CONFIG },
};

export function cloneHistoryPersistenceConfig(
	config: HistoryPersistenceConfig = DEFAULT_HISTORY_PERSISTENCE_CONFIG,
): HistoryPersistenceConfig {
	return {
		enabled: config.enabled,
		healthFileName: config.healthFileName,
		cascadeFileName: config.cascadeFileName,
	};
}

export function cloneCodexModelEntitlementConfig(
	config: CodexModelEntitlementConfig = DEFAULT_CODEX_MODEL_ENTITLEMENT_CONFIG,
): CodexModelEntitlementConfig {
	return {
		usageLookupFailureMode: config.usageLookupFailureMode,
	};
}

export function cloneModelEntitlementConfig(
	config: ModelEntitlementConfig = DEFAULT_MODEL_ENTITLEMENT_CONFIG,
): ModelEntitlementConfig {
	return {
		codex: cloneCodexModelEntitlementConfig(config.codex),
	};
}

export function cloneStreamTimeoutConfig(
	config: StreamTimeoutConfig = DEFAULT_STREAM_TIMEOUT_CONFIG,
): StreamTimeoutConfig {
	return {
		attemptTimeoutMs: config.attemptTimeoutMs,
		idleTimeoutMs: config.idleTimeoutMs,
	};
}

export function cloneProviderStreamTimeouts(
	value: ProviderStreamTimeoutOverrides = {},
): ProviderStreamTimeoutOverrides {
	const cloned: ProviderStreamTimeoutOverrides = {};
	for (const [providerId, timeouts] of Object.entries(value)) {
		if (!timeouts || typeof timeouts !== "object") {
			continue;
		}
		cloned[providerId] = { ...timeouts };
	}
	return cloned;
}

export function resolveProviderStreamTimeouts(
	providerId: string,
	defaults: StreamTimeoutConfig,
	overrides: ProviderStreamTimeoutOverrides = {},
): StreamTimeoutConfig {
	const override = overrides[providerId];
	if (!override) {
		return cloneStreamTimeoutConfig(defaults);
	}
	return {
		attemptTimeoutMs:
			typeof override.attemptTimeoutMs === "number" && Number.isFinite(override.attemptTimeoutMs)
				? override.attemptTimeoutMs
				: defaults.attemptTimeoutMs,
		idleTimeoutMs:
			typeof override.idleTimeoutMs === "number" && Number.isFinite(override.idleTimeoutMs)
				? override.idleTimeoutMs
				: defaults.idleTimeoutMs,
	};
}

export function cloneCredentialRotationConfig(
	config: CredentialRotationConfig = DEFAULT_CREDENTIAL_ROTATION_CONFIG,
): CredentialRotationConfig {
	return {
		autoDisableBrokenCredentials: config.autoDisableBrokenCredentials,
	};
}

export function cloneMultiAuthExtensionConfig(
	config: MultiAuthExtensionConfig = DEFAULT_MULTI_AUTH_CONFIG,
): MultiAuthExtensionConfig {
	return {
		debug: config.debug,
		hiddenProviders: [...config.hiddenProviders],
		rotationModes: { ...config.rotationModes },
		excludeProviders: [...config.excludeProviders],
		noCooldownProviders: [...config.noCooldownProviders],
		noStreamWatchdogProviders: [...config.noStreamWatchdogProviders],
		cascade: { ...config.cascade },
		health: {
			...config.health,
			weights: { ...config.health.weights },
		},
		historyPersistence: cloneHistoryPersistenceConfig(config.historyPersistence),
		modelEntitlements: cloneModelEntitlementConfig(config.modelEntitlements),
		oauthRefresh: cloneOAuthRefreshConfig(config.oauthRefresh),
		usageCoordination: { ...config.usageCoordination },
		streamTimeouts: cloneStreamTimeoutConfig(config.streamTimeouts),
		providerStreamTimeouts: cloneProviderStreamTimeouts(config.providerStreamTimeouts),
		credentialRotation: cloneCredentialRotationConfig(
			config.credentialRotation ?? DEFAULT_CREDENTIAL_ROTATION_CONFIG,
		),
	};
}

export function resolveExtensionRoot(moduleUrl = import.meta.url): string {
	const modulePath = fileURLToPath(moduleUrl);
	const moduleDir = dirname(modulePath);
	return basename(moduleDir) === "src" ? dirname(moduleDir) : moduleDir;
}

export const EXTENSION_ROOT = resolveExtensionRoot();
export const CONFIG_PATH = join(EXTENSION_ROOT, "config.json");
export const DEBUG_DIR = join(EXTENSION_ROOT, "debug");
export const DEBUG_LOG_PATH = join(DEBUG_DIR, `${MULTI_AUTH_EXTENSION_ID}-debug.jsonl`);

export interface HistoryPersistencePaths {
	healthPath: string;
	cascadePath: string;
}

export function resolveStateHistoryPersistencePaths(
	config: HistoryPersistenceConfig,
	debugDir = DEBUG_DIR,
): HistoryPersistencePaths {
	return {
		healthPath: join(debugDir, config.healthFileName),
		cascadePath: join(debugDir, config.cascadeFileName),
	};
}

function createDefaultConfigContent(): string {
	return `${JSON.stringify(DEFAULT_MULTI_AUTH_CONFIG, null, 2)}\n`;
}

function toRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) {
		return String(value);
	}
	if (value === undefined) {
		return "undefined";
	}

	try {
		return JSON.stringify(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
}

function createValidationWarning(path: string, reason: string, fallback: unknown): string {
	return `Invalid pi-multi-auth config '${path}': ${reason}. Using ${formatValue(fallback)}.`;
}

function appendWarning(warnings: string[], warning: string | undefined): void {
	if (warning) {
		warnings.push(warning);
	}
}

function readBoolean(
	value: unknown,
	path: string,
	defaultValue: boolean,
	warnings: string[],
): boolean {
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value === "boolean") {
		return value;
	}
	appendWarning(
		warnings,
		createValidationWarning(path, "expected a boolean", defaultValue),
	);
	return defaultValue;
}

function readStringArray(
	value: unknown,
	path: string,
	defaultValue: readonly string[],
	warnings: string[],
): string[] {
	if (value === undefined) {
		return [...defaultValue];
	}
	if (!Array.isArray(value)) {
		appendWarning(
			warnings,
			createValidationWarning(path, "expected an array of non-empty strings", defaultValue),
		);
		return [...defaultValue];
	}

	const normalized: string[] = [];
	const invalidEntries: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			invalidEntries.push(formatValue(entry));
			continue;
		}
		const trimmed = entry.trim();
		if (!trimmed) {
			invalidEntries.push(JSON.stringify(entry));
			continue;
		}
		normalized.push(trimmed);
	}

	if (invalidEntries.length > 0) {
		appendWarning(
			warnings,
			`Invalid pi-multi-auth config '${path}': ignored invalid entries (${invalidEntries.join(", ")}).`,
		);
	}

	return [...new Set(normalized)];
}

function readRotationModes(
	value: unknown,
	path: string,
	defaultValue: Readonly<Record<string, RotationMode>>,
	warnings: string[],
): Record<string, RotationMode> {
	if (value === undefined) {
		return { ...defaultValue };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		appendWarning(
			warnings,
			createValidationWarning(path, "expected an object keyed by provider id", defaultValue),
		);
		return { ...defaultValue };
	}

	const result: Record<string, RotationMode> = {};
	const invalidEntries: string[] = [];
	for (const [rawProvider, rawMode] of Object.entries(value)) {
		const provider = rawProvider.trim();
		if (!provider) {
			invalidEntries.push(JSON.stringify(rawProvider));
			continue;
		}
		if (rawMode !== "round-robin" && rawMode !== "usage-based" && rawMode !== "balancer") {
			invalidEntries.push(`${JSON.stringify(rawProvider)}=${formatValue(rawMode)}`);
			continue;
		}
		result[provider] = rawMode;
	}

	if (invalidEntries.length > 0) {
		appendWarning(
			warnings,
			`Invalid pi-multi-auth config '${path}': ignored invalid entries (${invalidEntries.join(", ")}).`,
		);
	}

	return result;
}

function readStringEnum<TValue extends string>(
	value: unknown,
	path: string,
	allowedValues: readonly TValue[],
	defaultValue: TValue,
	warnings: string[],
): TValue {
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value !== "string") {
		appendWarning(
			warnings,
			createValidationWarning(path, `expected one of ${allowedValues.join(", ")}`, defaultValue),
		);
		return defaultValue;
	}

	const normalized = value.trim() as TValue;
	if (allowedValues.includes(normalized)) {
		return normalized;
	}

	appendWarning(
		warnings,
		createValidationWarning(path, `expected one of ${allowedValues.join(", ")}`, defaultValue),
	);
	return defaultValue;
}

function readNonNegativeInteger(
	value: unknown,
	path: string,
	defaultValue: number,
	warnings: string[],
): number {
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		return value;
	}
	appendWarning(
		warnings,
		createValidationWarning(path, "expected a non-negative integer", defaultValue),
	);
	return defaultValue;
}

function readPositiveInteger(
	value: unknown,
	path: string,
	defaultValue: number,
	warnings: string[],
): number {
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	appendWarning(
		warnings,
		createValidationWarning(path, "expected a positive integer", defaultValue),
	);
	return defaultValue;
}

function readFiniteNumber(
	value: unknown,
	path: string,
	defaultValue: number,
	warnings: string[],
	minimum?: number,
): number {
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value === "number" && Number.isFinite(value) && (minimum === undefined || value >= minimum)) {
		return value;
	}
	const minimumMessage = minimum === undefined ? "a finite number" : `a finite number >= ${minimum}`;
	appendWarning(
		warnings,
		createValidationWarning(path, `expected ${minimumMessage}`, defaultValue),
	);
	return defaultValue;
}

function readJsonFileName(
	value: unknown,
	path: string,
	defaultValue: string,
	warnings: string[],
): string {
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value !== "string") {
		appendWarning(
			warnings,
			createValidationWarning(path, "expected a JSON file name", defaultValue),
		);
		return defaultValue;
	}

	const trimmed = value.trim();
	const invalidFileName =
		trimmed.length === 0 ||
		basename(trimmed) !== trimmed ||
		!trimmed.toLowerCase().endsWith(".json");
	if (invalidFileName) {
		appendWarning(
			warnings,
			createValidationWarning(
				path,
				"expected a JSON file name without directory segments",
				defaultValue,
			),
		);
		return defaultValue;
	}

	return trimmed;
}

function normalizeHealthWeights(value: unknown, warnings: string[]): HealthScoreWeights {
	const defaults = DEFAULT_HEALTH_WEIGHTS;
	const record = toRecord(value);
	const weights: HealthScoreWeights = {
		successRate: readFiniteNumber(
			record.successRate,
			"health.weights.successRate",
			defaults.successRate,
			warnings,
			0,
		),
		latencyFactor: readFiniteNumber(
			record.latencyFactor,
			"health.weights.latencyFactor",
			defaults.latencyFactor,
			warnings,
			0,
		),
		uptimeFactor: readFiniteNumber(
			record.uptimeFactor,
			"health.weights.uptimeFactor",
			defaults.uptimeFactor,
			warnings,
			0,
		),
		recoveryFactor: readFiniteNumber(
			record.recoveryFactor,
			"health.weights.recoveryFactor",
			defaults.recoveryFactor,
			warnings,
			0,
		),
	};

	const totalWeight = Object.values(weights).reduce((sum, entry) => sum + entry, 0);
	if (totalWeight <= 0) {
		appendWarning(
			warnings,
			createValidationWarning(
				"health.weights",
				"at least one weight must be greater than zero",
				defaults,
			),
		);
		return { ...defaults };
	}

	return weights;
}

function normalizeCascadeConfig(value: unknown, warnings: string[]): CascadeConfig {
	const defaults = DEFAULT_CASCADE_CONFIG;
	const record = toRecord(value);
	const initialBackoffMs = readPositiveInteger(
		record.initialBackoffMs,
		"cascade.initialBackoffMs",
		defaults.initialBackoffMs,
		warnings,
	);
	let maxBackoffMs = readPositiveInteger(
		record.maxBackoffMs,
		"cascade.maxBackoffMs",
		defaults.maxBackoffMs,
		warnings,
	);
	const backoffMultiplier = readFiniteNumber(
		record.backoffMultiplier,
		"cascade.backoffMultiplier",
		defaults.backoffMultiplier,
		warnings,
		1,
	);
	const maxHistoryEntries = readPositiveInteger(
		record.maxHistoryEntries,
		"cascade.maxHistoryEntries",
		defaults.maxHistoryEntries,
		warnings,
	);

	if (maxBackoffMs < initialBackoffMs) {
		appendWarning(
			warnings,
			`Invalid pi-multi-auth config 'cascade.maxBackoffMs': expected a value >= cascade.initialBackoffMs (${initialBackoffMs}). Using ${initialBackoffMs}.`,
		);
		maxBackoffMs = initialBackoffMs;
	}

	return {
		initialBackoffMs,
		maxBackoffMs,
		backoffMultiplier,
		maxHistoryEntries,
	};
}

function normalizeHealthConfig(value: unknown, warnings: string[]): HealthMetricsConfig {
	const defaults = DEFAULT_HEALTH_CONFIG;
	const record = toRecord(value);
	const windowSize = readPositiveInteger(
		record.windowSize,
		"health.windowSize",
		defaults.windowSize,
		warnings,
	);
	const maxLatencyMs = readPositiveInteger(
		record.maxLatencyMs,
		"health.maxLatencyMs",
		defaults.maxLatencyMs,
		warnings,
	);
	const uptimeWindowMs = readPositiveInteger(
		record.uptimeWindowMs,
		"health.uptimeWindowMs",
		defaults.uptimeWindowMs,
		warnings,
	);
	const minRequests = readPositiveInteger(
		record.minRequests,
		"health.minRequests",
		defaults.minRequests,
		warnings,
	);
	const staleThresholdMs = readPositiveInteger(
		record.staleThresholdMs,
		"health.staleThresholdMs",
		defaults.staleThresholdMs,
		warnings,
	);

	return {
		windowSize,
		maxLatencyMs,
		uptimeWindowMs,
		minRequests,
		staleThresholdMs,
		weights: normalizeHealthWeights(record.weights, warnings),
	};
}

function normalizeHistoryPersistenceConfig(
	value: unknown,
	warnings: string[],
): HistoryPersistenceConfig {
	const defaults = DEFAULT_HISTORY_PERSISTENCE_CONFIG;
	const record = toRecord(value);
	return {
		enabled: readBoolean(
			record.enabled,
			"historyPersistence.enabled",
			defaults.enabled,
			warnings,
		),
		healthFileName: readJsonFileName(
			record.healthFileName,
			"historyPersistence.healthFileName",
			defaults.healthFileName,
			warnings,
		),
		cascadeFileName: readJsonFileName(
			record.cascadeFileName,
			"historyPersistence.cascadeFileName",
			defaults.cascadeFileName,
			warnings,
		),
	};
}

function normalizeCodexModelEntitlementConfig(
	value: unknown,
	warnings: string[],
): CodexModelEntitlementConfig {
	const defaults = DEFAULT_CODEX_MODEL_ENTITLEMENT_CONFIG;
	const record = toRecord(value);
	return {
		usageLookupFailureMode: readStringEnum(
			record.usageLookupFailureMode,
			"modelEntitlements.codex.usageLookupFailureMode",
			["strict", "allow-unverified"],
			defaults.usageLookupFailureMode,
			warnings,
		),
	};
}

function normalizeModelEntitlementConfig(
	value: unknown,
	warnings: string[],
): ModelEntitlementConfig {
	const defaults = DEFAULT_MODEL_ENTITLEMENT_CONFIG;
	const record = toRecord(value);
	return {
		codex: normalizeCodexModelEntitlementConfig(record.codex ?? defaults.codex, warnings),
	};
}

function normalizeOAuthRefreshConfig(value: unknown, warnings: string[]): OAuthRefreshConfig {
	const defaults = DEFAULT_OAUTH_CONFIG;
	const record = toRecord(value);
	return {
		safetyWindowMs: readNonNegativeInteger(
			record.safetyWindowMs,
			"oauthRefresh.safetyWindowMs",
			defaults.safetyWindowMs,
			warnings,
		),
		minRefreshWindowMs: readNonNegativeInteger(
			record.minRefreshWindowMs,
			"oauthRefresh.minRefreshWindowMs",
			defaults.minRefreshWindowMs,
			warnings,
		),
		checkIntervalMs: readPositiveInteger(
			record.checkIntervalMs,
			"oauthRefresh.checkIntervalMs",
			defaults.checkIntervalMs,
			warnings,
		),
		maxConcurrentRefreshes: readPositiveInteger(
			record.maxConcurrentRefreshes,
			"oauthRefresh.maxConcurrentRefreshes",
			defaults.maxConcurrentRefreshes,
			warnings,
		),
		requestTimeoutMs: readPositiveInteger(
			record.requestTimeoutMs,
			"oauthRefresh.requestTimeoutMs",
			defaults.requestTimeoutMs,
			warnings,
		),
		enabled: readBoolean(record.enabled, "oauthRefresh.enabled", defaults.enabled, warnings),
		excludedProviders: readStringArray(
			record.excludedProviders,
			"oauthRefresh.excludedProviders",
			defaults.excludedProviders,
			warnings,
		),
	};
}

function normalizeStreamTimeoutConfig(value: unknown, warnings: string[]): StreamTimeoutConfig {
	const defaults = DEFAULT_STREAM_TIMEOUT_CONFIG;
	const record = toRecord(value);
	return {
		attemptTimeoutMs: readNonNegativeInteger(
			record.attemptTimeoutMs,
			"streamTimeouts.attemptTimeoutMs",
			defaults.attemptTimeoutMs,
			warnings,
		),
		idleTimeoutMs: readNonNegativeInteger(
			record.idleTimeoutMs,
			"streamTimeouts.idleTimeoutMs",
			defaults.idleTimeoutMs,
			warnings,
		),
	};
}

function normalizeProviderStreamTimeouts(
	value: unknown,
	warnings: string[],
): ProviderStreamTimeoutOverrides {
	const record = toRecord(value);
	const result: ProviderStreamTimeoutOverrides = {};
	for (const [providerId, rawEntry] of Object.entries(record)) {
		const trimmedId = providerId.trim();
		if (!trimmedId) {
			continue;
		}
		const entry = toRecord(rawEntry);
		const hasAttempt = entry.attemptTimeoutMs !== undefined;
		const hasIdle = entry.idleTimeoutMs !== undefined;
		if (!hasAttempt && !hasIdle) {
			appendWarning(
				warnings,
				`providerStreamTimeouts.${trimmedId}: expected attemptTimeoutMs and/or idleTimeoutMs; entry ignored.`,
			);
			continue;
		}
		const override: Partial<StreamTimeoutConfig> = {};
		if (hasAttempt) {
			override.attemptTimeoutMs = readNonNegativeInteger(
				entry.attemptTimeoutMs,
				`providerStreamTimeouts.${trimmedId}.attemptTimeoutMs`,
				DEFAULT_STREAM_TIMEOUT_CONFIG.attemptTimeoutMs,
				warnings,
			);
		}
		if (hasIdle) {
			override.idleTimeoutMs = readNonNegativeInteger(
				entry.idleTimeoutMs,
				`providerStreamTimeouts.${trimmedId}.idleTimeoutMs`,
				DEFAULT_STREAM_TIMEOUT_CONFIG.idleTimeoutMs,
				warnings,
			);
		}
		result[trimmedId] = override;
	}
	return result;
}

function normalizeUsageCoordinationConfig(
	value: unknown,
	warnings: string[],
): UsageCoordinationConfig {
	const defaults = DEFAULT_USAGE_COORDINATION_CONFIG;
	const record = toRecord(value);
	return {
		enabled: readBoolean(record.enabled, "usageCoordination.enabled", defaults.enabled, warnings),
		globalMaxConcurrentFreshRequests: readPositiveInteger(
			record.globalMaxConcurrentFreshRequests,
			"usageCoordination.globalMaxConcurrentFreshRequests",
			defaults.globalMaxConcurrentFreshRequests,
			warnings,
		),
		perProviderMaxConcurrentFreshRequests: readPositiveInteger(
			record.perProviderMaxConcurrentFreshRequests,
			"usageCoordination.perProviderMaxConcurrentFreshRequests",
			defaults.perProviderMaxConcurrentFreshRequests,
			warnings,
		),
		selectionCandidateWindow: readPositiveInteger(
			record.selectionCandidateWindow,
			"usageCoordination.selectionCandidateWindow",
			defaults.selectionCandidateWindow,
			warnings,
		),
		blockedReconciliationCandidateWindow: readPositiveInteger(
			record.blockedReconciliationCandidateWindow,
			"usageCoordination.blockedReconciliationCandidateWindow",
			defaults.blockedReconciliationCandidateWindow,
			warnings,
		),
		entitlementCandidateWindow: readPositiveInteger(
			record.entitlementCandidateWindow,
			"usageCoordination.entitlementCandidateWindow",
			defaults.entitlementCandidateWindow,
			warnings,
		),
		startupCandidateWindow: readPositiveInteger(
			record.startupCandidateWindow,
			"usageCoordination.startupCandidateWindow",
			defaults.startupCandidateWindow,
			warnings,
		),
		modalRefreshCandidateWindow: readPositiveInteger(
			record.modalRefreshCandidateWindow,
			"usageCoordination.modalRefreshCandidateWindow",
			defaults.modalRefreshCandidateWindow,
			warnings,
		),
		manualProviderRefreshCandidateWindow: readPositiveInteger(
			record.manualProviderRefreshCandidateWindow,
			"usageCoordination.manualProviderRefreshCandidateWindow",
			defaults.manualProviderRefreshCandidateWindow,
			warnings,
		),
		accountCooldownMs: readNonNegativeInteger(
			record.accountCooldownMs,
			"usageCoordination.accountCooldownMs",
			defaults.accountCooldownMs,
			warnings,
		),
		authCooldownMs: readNonNegativeInteger(
			record.authCooldownMs,
			"usageCoordination.authCooldownMs",
			defaults.authCooldownMs,
			warnings,
		),
		providerCooldownMs: readNonNegativeInteger(
			record.providerCooldownMs,
			"usageCoordination.providerCooldownMs",
			defaults.providerCooldownMs,
			warnings,
		),
		circuitBreakerFailureThreshold: readPositiveInteger(
			record.circuitBreakerFailureThreshold,
			"usageCoordination.circuitBreakerFailureThreshold",
			defaults.circuitBreakerFailureThreshold,
			warnings,
		),
		circuitBreakerCooldownMs: readNonNegativeInteger(
			record.circuitBreakerCooldownMs,
			"usageCoordination.circuitBreakerCooldownMs",
			defaults.circuitBreakerCooldownMs,
			warnings,
		),
		jitterMs: readNonNegativeInteger(
			record.jitterMs,
			"usageCoordination.jitterMs",
			defaults.jitterMs,
			warnings,
		),
	};
}

function normalizeConfig(raw: unknown): { config: MultiAuthExtensionConfig; warnings: string[] } {
	const warnings: string[] = [];
	if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
		appendWarning(
			warnings,
			createValidationWarning("$", "expected a JSON object", DEFAULT_MULTI_AUTH_CONFIG),
		);
	}

	const record = toRecord(raw);
	const hiddenProviders = readStringArray(
		record.hiddenProviders,
		"hiddenProviders",
		DEFAULT_MULTI_AUTH_CONFIG.hiddenProviders,
		warnings,
	);
	return {
		config: {
			debug: readBoolean(record.debug, "debug", DEFAULT_MULTI_AUTH_CONFIG.debug, warnings),
			hiddenProviders,
			rotationModes: readRotationModes(
				record.rotationModes,
				"rotationModes",
				DEFAULT_MULTI_AUTH_CONFIG.rotationModes,
				warnings,
			),
			excludeProviders: [],
			noCooldownProviders: readStringArray(
				record.noCooldownProviders,
				"noCooldownProviders",
				DEFAULT_MULTI_AUTH_CONFIG.noCooldownProviders,
				warnings,
			),
			noStreamWatchdogProviders: readStringArray(
				record.noStreamWatchdogProviders,
				"noStreamWatchdogProviders",
				DEFAULT_MULTI_AUTH_CONFIG.noStreamWatchdogProviders,
				warnings,
			),
			cascade: normalizeCascadeConfig(record.cascade, warnings),
			health: normalizeHealthConfig(record.health, warnings),
			historyPersistence: normalizeHistoryPersistenceConfig(record.historyPersistence, warnings),
			modelEntitlements: normalizeModelEntitlementConfig(record.modelEntitlements, warnings),
			oauthRefresh: normalizeOAuthRefreshConfig(record.oauthRefresh, warnings),
			usageCoordination: normalizeUsageCoordinationConfig(record.usageCoordination, warnings),
			streamTimeouts: normalizeStreamTimeoutConfig(record.streamTimeouts, warnings),
			providerStreamTimeouts: normalizeProviderStreamTimeouts(
				record.providerStreamTimeouts,
				warnings,
			),
			credentialRotation: normalizeCredentialRotationConfig(record.credentialRotation, warnings),
		},
		warnings,
	};
}

function normalizeCredentialRotationConfig(
	value: unknown,
	warnings: string[],
): CredentialRotationConfig {
	const defaults = DEFAULT_CREDENTIAL_ROTATION_CONFIG;
	const record = toRecord(value);
	return {
		autoDisableBrokenCredentials: readBoolean(
			record.autoDisableBrokenCredentials,
			"credentialRotation.autoDisableBrokenCredentials",
			defaults.autoDisableBrokenCredentials,
			warnings,
		),
	};
}

function joinWarnings(warnings: Array<string | undefined>): string | undefined {
	const messages = warnings.filter((warning): warning is string => Boolean(warning?.trim()));
	return messages.length > 0 ? messages.join(" ") : undefined;
}

function ensureConfigDirectory(configPath: string): void {
	mkdirSync(dirname(configPath), { recursive: true });
}

export function ensureMultiAuthConfig(configPath = CONFIG_PATH): { created: boolean; warning?: string } {
	if (existsSync(configPath)) {
		return { created: false };
	}

	try {
		ensureConfigDirectory(configPath);
		writeFileSync(configPath, createDefaultConfigContent(), "utf-8");
		return { created: true };
	} catch (error) {
		const message = getErrorMessage(error);
		return {
			created: false,
			warning: `Failed to initialize pi-multi-auth config at '${configPath}': ${message}`,
		};
	}
}

export function loadMultiAuthConfig(configPath = CONFIG_PATH): MultiAuthConfigLoadResult {
	const ensureResult = ensureMultiAuthConfig(configPath);

	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		const normalized = normalizeConfig(parsed);
		return {
			config: normalized.config,
			created: ensureResult.created,
			warning: joinWarnings([ensureResult.warning, ...normalized.warnings]),
		};
	} catch (error) {
		const message = getErrorMessage(error);
		return {
			config: cloneMultiAuthExtensionConfig(),
			created: ensureResult.created,
			warning: joinWarnings([
				ensureResult.warning,
				`Failed to read pi-multi-auth config at '${configPath}': ${message}`,
			]),
		};
	}
}

function readCurrentWritableConfig(configPath: string): { config: MultiAuthExtensionConfig; warnings: string[] } {
	const raw = readFileSync(configPath, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	return normalizeConfig(parsed);
}

function writeMultiAuthConfig(config: MultiAuthExtensionConfig, configPath: string): void {
	const { excludeProviders: _exclude, ...persisted } = config;
	writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
}

export function writeMultiAuthProviderHidden(
	provider: string,
	hidden: boolean,
	configPath = CONFIG_PATH,
): string[] {
	const normalizedProvider = provider.trim();
	if (!normalizedProvider) {
		throw new Error("Provider id is required to persist hidden-provider state.");
	}

	const ensureResult = ensureMultiAuthConfig(configPath);
	if (ensureResult.warning) {
		throw new Error(ensureResult.warning);
	}

	const current = readCurrentWritableConfig(configPath);
	if (current.warnings.length > 0) {
		throw new Error(current.warnings.join(" "));
	}

	const hiddenProviders = new Set(current.config.hiddenProviders);
	if (hidden) {
		hiddenProviders.add(normalizedProvider);
	} else {
		hiddenProviders.delete(normalizedProvider);
	}

	const nextConfig: MultiAuthExtensionConfig = {
		...current.config,
		hiddenProviders: [...hiddenProviders],
	};
	writeMultiAuthConfig(nextConfig, configPath);
	return [...nextConfig.hiddenProviders];
}

export function writeMultiAuthProviderRotationMode(
	provider: string,
	rotationMode: RotationMode,
	configPath = CONFIG_PATH,
): Record<string, RotationMode> {
	const normalizedProvider = provider.trim();
	if (!normalizedProvider) {
		throw new Error("Provider id is required to persist a rotation mode.");
	}
	if (rotationMode !== "round-robin" && rotationMode !== "usage-based" && rotationMode !== "balancer") {
		throw new Error(`Invalid rotation mode '${rotationMode}'.`);
	}

	const ensureResult = ensureMultiAuthConfig(configPath);
	if (ensureResult.warning) {
		throw new Error(ensureResult.warning);
	}

	const current = readCurrentWritableConfig(configPath);
	if (current.warnings.length > 0) {
		throw new Error(current.warnings.join(" "));
	}

	const nextConfig: MultiAuthExtensionConfig = {
		...current.config,
		rotationModes: {
			...current.config.rotationModes,
			[normalizedProvider]: rotationMode,
		},
	};
	writeMultiAuthConfig(nextConfig, configPath);
	return { ...nextConfig.rotationModes };
}

export function ensureMultiAuthDebugDirectory(debugDir = DEBUG_DIR): string | undefined {
	try {
		mkdirSync(debugDir, { recursive: true });
		return undefined;
	} catch (error) {
		const message = getErrorMessage(error);
		return `Failed to create pi-multi-auth debug directory '${debugDir}': ${message}`;
	}
}
