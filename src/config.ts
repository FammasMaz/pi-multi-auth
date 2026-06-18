import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getErrorMessage } from "./auth-error-utils.js";
import type { RotationMode } from "./types.js";

export const MULTI_AUTH_EXTENSION_ID = "pi-multi-auth";

export interface MultiAuthExtensionConfig {
	debug: boolean;
	/** Providers hidden from pi-multi-auth UI and runtime work. */
	hiddenProviders: string[];
	/** Provider rotation-mode overrides saved outside multi-auth.json. */
	rotationModes: Record<string, RotationMode>;
}

export interface MultiAuthConfigLoadResult {
	config: MultiAuthExtensionConfig;
	created: boolean;
	warning?: string;
}

export const DEFAULT_MULTI_AUTH_CONFIG: MultiAuthExtensionConfig = {
	debug: false,
	hiddenProviders: [],
	rotationModes: {},
};

export function cloneMultiAuthExtensionConfig(
	config: MultiAuthExtensionConfig = DEFAULT_MULTI_AUTH_CONFIG,
): MultiAuthExtensionConfig {
	return {
		debug: config.debug,
		hiddenProviders: [...config.hiddenProviders],
		rotationModes: { ...config.rotationModes },
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

function normalizeConfig(raw: unknown): { config: MultiAuthExtensionConfig; warnings: string[] } {
	const warnings: string[] = [];
	if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
		appendWarning(
			warnings,
			createValidationWarning("$", "expected a JSON object", DEFAULT_MULTI_AUTH_CONFIG),
		);
	}

	const record = toRecord(raw);
	return {
		config: {
			debug: readBoolean(record.debug, "debug", DEFAULT_MULTI_AUTH_CONFIG.debug, warnings),
			hiddenProviders: readStringArray(
				record.hiddenProviders,
				"hiddenProviders",
				DEFAULT_MULTI_AUTH_CONFIG.hiddenProviders,
				warnings,
			),
			rotationModes: readRotationModes(
				record.rotationModes,
				"rotationModes",
				DEFAULT_MULTI_AUTH_CONFIG.rotationModes,
				warnings,
			),
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
	const record = toRecord(parsed);
	const warnings: string[] = [];
	return {
		config: {
			debug: readBoolean(record.debug, "debug", DEFAULT_MULTI_AUTH_CONFIG.debug, warnings),
			hiddenProviders: readStringArray(
				record.hiddenProviders,
				"hiddenProviders",
				DEFAULT_MULTI_AUTH_CONFIG.hiddenProviders,
				warnings,
			),
			rotationModes: readRotationModes(
				record.rotationModes,
				"rotationModes",
				DEFAULT_MULTI_AUTH_CONFIG.rotationModes,
				warnings,
			),
		},
		warnings,
	};
}

function writeMultiAuthConfig(config: MultiAuthExtensionConfig, configPath: string): void {
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
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
