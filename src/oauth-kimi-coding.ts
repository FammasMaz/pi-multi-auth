import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "./oauth-compat.js";
import {
	registerOAuthProvider,
	unregisterOAuthProvider,
} from "./oauth-compat.js";
import { fetchWithTimeout } from "./async-utils.js";
import {
	isRecord,
	normalizeNonEmptyString,
	throwFixedAbortErrorIfAborted,
} from "./auth-error-utils.js";
import { OAuthRefreshFailureError } from "./types-oauth.js";
import {
	DEVICE_CODE_GRANT_TYPE,
	resolvePositiveInteger,
	parseJsonRecord,
	readResponsePayload,
	createCancelableSleep,
	createFormUrlEncodedHeaders,
} from "./oauth-shared-utils.js";

const KIMI_PROVIDER_ID = "kimi-coding";
const KIMI_PROVIDER_NAME = "Kimi For Coding";
const DEFAULT_KIMI_CLIENT_ID =
	process.env.KIMI_CODING_OAUTH_CLIENT_ID ?? "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_KIMI_DEVICE_CODE_URL = "https://auth.kimi.com/api/oauth/device_authorization";
const DEFAULT_KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const KIMI_OAUTH_CANCELLED_MESSAGE = "Kimi Coding OAuth login was cancelled.";
const KIMI_VERIFICATION_URL = "https://www.kimi.com/code/authorize_device";

interface DeviceCodeResponse {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	expiresIn: number;
	intervalSeconds?: number;
}

interface TokenResponse {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
}

export interface KimiCodingOAuthProviderDependencies {
	fetchImplementation: typeof fetch;
	deviceCodeUrl: string;
	tokenUrl: string;
	clientId: string;
	pollIntervalMs: number;
	requestTimeoutMs: number;
	now: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function parseDeviceCodeResponse(payload: Record<string, unknown> | null): DeviceCodeResponse {
	const deviceCode = normalizeNonEmptyString(payload?.device_code);
	const userCode = normalizeNonEmptyString(payload?.user_code);
	const verificationUrl =
		normalizeNonEmptyString(payload?.verification_uri_complete) ??
		(normalizeNonEmptyString(payload?.verification_uri)
			? `${normalizeNonEmptyString(payload?.verification_uri)}?user_code=${encodeURIComponent(userCode ?? "")}`
			: `${KIMI_VERIFICATION_URL}?user_code=${encodeURIComponent(userCode ?? "")}`);
	const expiresIn = payload?.expires_in;
	const intervalSeconds = payload?.interval;
	if (!deviceCode || !userCode || !verificationUrl) {
		throw new Error("Kimi Coding device authorization response was missing required fields.");
	}
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new Error("Kimi Coding device authorization response was missing a valid expires_in value.");
	}
	return {
		deviceCode,
		userCode,
		verificationUrl,
		expiresIn,
		intervalSeconds:
			typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds) && intervalSeconds > 0
				? intervalSeconds
				: undefined,
	};
}

function extractTokenResponse(payload: Record<string, unknown> | null): TokenResponse {
	const accessToken = normalizeNonEmptyString(payload?.access_token);
	const refreshToken = normalizeNonEmptyString(payload?.refresh_token);
	const expiresIn = payload?.expires_in;
	if (!accessToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new Error("Kimi Coding token response was missing required fields.");
	}
	return {
		accessToken,
		refreshToken,
		expiresIn,
	};
}

function buildStoredCredentials(
	response: TokenResponse,
	dependencies: KimiCodingOAuthProviderDependencies,
): OAuthCredentials {
	return {
		access: response.accessToken,
		refresh: response.refreshToken ?? response.accessToken,
		expires: dependencies.now() + response.expiresIn * 1000,
		provider: KIMI_PROVIDER_ID,
	};
}

async function requestDeviceCode(
	dependencies: KimiCodingOAuthProviderDependencies,
	signal: AbortSignal | undefined,
): Promise<DeviceCodeResponse> {
	const response = await fetchWithTimeout(
		dependencies.deviceCodeUrl,
		{
			method: "POST",
			headers: createFormUrlEncodedHeaders(),
			body: new URLSearchParams({
				client_id: dependencies.clientId,
			}).toString(),
		},
		{
			fetchImplementation: dependencies.fetchImplementation,
			timeoutMs: dependencies.requestTimeoutMs,
			signal,
			abortMessage: KIMI_OAUTH_CANCELLED_MESSAGE,
		},
	);
	const payload = await readResponsePayload(response);
	if (!response.ok) {
		throw new Error(
			normalizeNonEmptyString(payload.json?.error_description) ??
				`Failed to initiate Kimi Coding device authorization: ${response.status}`,
		);
	}
	return parseDeviceCodeResponse(payload.json);
}

async function requestToken(
	dependencies: KimiCodingOAuthProviderDependencies,
	body: URLSearchParams,
	signal: AbortSignal | undefined,
): Promise<{ response: Response; payload: Record<string, unknown> | null }> {
	const response = await fetchWithTimeout(
		dependencies.tokenUrl,
		{
			method: "POST",
			headers: createFormUrlEncodedHeaders(),
			body: body.toString(),
		},
		{
			fetchImplementation: dependencies.fetchImplementation,
			timeoutMs: dependencies.requestTimeoutMs,
			signal,
			abortMessage: KIMI_OAUTH_CANCELLED_MESSAGE,
		},
	);
	const payload = await readResponsePayload(response);
	return { response, payload: payload.json };
}

async function pollForToken(
	dependencies: KimiCodingOAuthProviderDependencies,
	deviceCode: DeviceCodeResponse,
	signal: AbortSignal | undefined,
): Promise<TokenResponse> {
	const deadline = dependencies.now() + deviceCode.expiresIn * 1000;
	let intervalMs = Math.max(
		1_000,
		Math.floor((deviceCode.intervalSeconds ?? dependencies.pollIntervalMs / 1000) * 1000),
	);

	while (dependencies.now() < deadline) {
		throwFixedAbortErrorIfAborted(signal, KIMI_OAUTH_CANCELLED_MESSAGE);
		const { response, payload } = await requestToken(
			dependencies,
			new URLSearchParams({
				grant_type: DEVICE_CODE_GRANT_TYPE,
				client_id: dependencies.clientId,
				device_code: deviceCode.deviceCode,
			}),
			signal,
		);
		const errorCode = normalizeNonEmptyString(payload?.error);
		if (response.ok) {
			return extractTokenResponse(payload);
		}
		if (errorCode === "authorization_pending") {
			await dependencies.sleep(intervalMs, signal);
			continue;
		}
		if (errorCode === "slow_down") {
			intervalMs = Math.min(intervalMs + 5_000, 15_000);
			await dependencies.sleep(intervalMs, signal);
			continue;
		}
		if (errorCode === "expired_token") {
			throw new Error("Kimi Coding authorization code expired. Please try again.");
		}
		if (errorCode === "access_denied") {
			throw new Error("Kimi Coding authorization was denied by the user.");
		}
		throw new Error(
			normalizeNonEmptyString(payload?.error_description) ??
				normalizeNonEmptyString(payload?.error) ??
				`Kimi Coding token request failed: ${response.status}`,
		);
	}

	throw new Error("Kimi Coding authentication timed out. Please try again.");
}

async function loginKimiCoding(
	callbacks: OAuthLoginCallbacks,
	dependencies: KimiCodingOAuthProviderDependencies,
): Promise<OAuthCredentials> {
	throwFixedAbortErrorIfAborted(callbacks.signal, KIMI_OAUTH_CANCELLED_MESSAGE);
	callbacks.onProgress?.("Initiating Kimi Coding device authorization...");
	const deviceCode = await requestDeviceCode(dependencies, callbacks.signal);
	callbacks.onAuth({ url: deviceCode.verificationUrl });
	callbacks.onProgress?.("Waiting for Kimi Coding browser authorization...");
	const tokenResponse = await pollForToken(dependencies, deviceCode, callbacks.signal);
	callbacks.onProgress?.("Kimi Coding login successful.");
	return buildStoredCredentials(tokenResponse, dependencies);
}

async function refreshKimiCodingCredentials(
	credentials: OAuthCredentials,
	dependencies: KimiCodingOAuthProviderDependencies,
): Promise<OAuthCredentials> {
	const refreshToken = normalizeNonEmptyString(credentials.refresh);
	if (!refreshToken) {
		throw new OAuthRefreshFailureError(
			"Kimi Coding OAuth credentials are missing a refresh token.",
			{
				providerId: KIMI_PROVIDER_ID,
				reason: "missing_refresh_token",
				permanent: true,
				source: "extension",
			},
		);
	}

	const { response, payload } = await requestToken(
		dependencies,
		new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: dependencies.clientId,
		}),
		undefined,
	);
	if (!response.ok) {
		throw new OAuthRefreshFailureError(
			normalizeNonEmptyString(payload?.error_description) ??
				normalizeNonEmptyString(payload?.error) ??
				"Kimi Coding token refresh failed.",
			{
				providerId: KIMI_PROVIDER_ID,
				status: response.status,
				reason: response.status === 400 || response.status === 401 ? "token_rejected" : "http_error",
				permanent: response.status === 400 || response.status === 401,
				source: "extension",
			},
		);
	}

	return {
		...credentials,
		...buildStoredCredentials(extractTokenResponse(payload), dependencies),
	};
}

export function createKimiCodingOAuthProvider(
	dependencies: Partial<KimiCodingOAuthProviderDependencies> = {},
): OAuthProviderInterface {
	const resolvedDependencies: KimiCodingOAuthProviderDependencies = {
		fetchImplementation: dependencies.fetchImplementation ?? fetch,
		deviceCodeUrl:
			normalizeNonEmptyString(dependencies.deviceCodeUrl) ?? DEFAULT_KIMI_DEVICE_CODE_URL,
		tokenUrl: normalizeNonEmptyString(dependencies.tokenUrl) ?? DEFAULT_KIMI_TOKEN_URL,
		clientId: normalizeNonEmptyString(dependencies.clientId) ?? DEFAULT_KIMI_CLIENT_ID,
		pollIntervalMs: resolvePositiveInteger(dependencies.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
		requestTimeoutMs: resolvePositiveInteger(
			dependencies.requestTimeoutMs,
			DEFAULT_REQUEST_TIMEOUT_MS,
		),
		now: dependencies.now ?? (() => Date.now()),
		sleep: dependencies.sleep ?? ((ms, signal) => createCancelableSleep(ms, signal, KIMI_OAUTH_CANCELLED_MESSAGE)),
	};

	return {
		id: KIMI_PROVIDER_ID,
		name: KIMI_PROVIDER_NAME,
		usesCallbackServer: false,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			return loginKimiCoding(callbacks, resolvedDependencies);
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return refreshKimiCodingCredentials(credentials, resolvedDependencies);
		},
		getApiKey(credentials: OAuthCredentials): string {
			const accessToken = normalizeNonEmptyString(credentials.access);
			if (!accessToken) {
				throw new Error("Kimi Coding OAuth credentials are missing an access token.");
			}
			return accessToken;
		},
	};
}

export const kimiCodingOAuthProvider = createKimiCodingOAuthProvider();

export function registerKimiCodingOAuthProvider(): void {
	registerOAuthProvider(kimiCodingOAuthProvider);
}

export function unregisterKimiCodingOAuthProvider(): void {
	unregisterOAuthProvider(KIMI_PROVIDER_ID);
}
