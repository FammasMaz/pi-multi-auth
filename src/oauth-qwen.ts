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
	toBase64Url,
} from "./oauth-shared-utils.js";

const QWEN_PROVIDER_ID = "qwen";
const QWEN_PROVIDER_NAME = "Qwen";
const DEFAULT_QWEN_CLIENT_ID =
	process.env.QWEN_OAUTH_CLIENT_ID ?? "f0304373b74a44d2b584a3fb70ca9e56";
const DEFAULT_QWEN_SCOPE = "openid profile email model.completion";
const DEFAULT_QWEN_DEVICE_CODE_URL = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const DEFAULT_QWEN_TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";
const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const QWEN_OAUTH_CANCELLED_MESSAGE = "Qwen OAuth login was cancelled.";

interface DeviceCodeResponse {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	instructions?: string;
	expiresIn: number;
	intervalSeconds?: number;
}

interface TokenResponse {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
	resourceUrl?: string;
}

export interface QwenPkcePair {
	verifier: string;
	challenge: string;
}

export interface QwenOAuthProviderDependencies {
	fetchImplementation: typeof fetch;
	deviceCodeUrl: string;
	tokenUrl: string;
	clientId: string;
	scope: string;
	defaultBaseUrl: string;
	pollIntervalMs: number;
	requestTimeoutMs: number;
	now: () => number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	generatePkcePair: () => Promise<QwenPkcePair>;
}

async function generateDefaultPkcePair(): Promise<QwenPkcePair> {
	const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = toBase64Url(verifierBytes);
	const challengeBytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
	);
	return {
		verifier,
		challenge: toBase64Url(challengeBytes),
	};
}

function parseDeviceCodeResponse(payload: Record<string, unknown> | null): DeviceCodeResponse {
	const deviceCode = normalizeNonEmptyString(payload?.device_code);
	const userCode = normalizeNonEmptyString(payload?.user_code);
	const verificationUrlComplete = normalizeNonEmptyString(payload?.verification_uri_complete);
	const verificationUrl =
		verificationUrlComplete ?? normalizeNonEmptyString(payload?.verification_uri);
	const expiresIn = payload?.expires_in;
	const intervalSeconds = payload?.interval;
	if (!deviceCode || !userCode || !verificationUrl) {
		throw new Error("Qwen device authorization response was missing required fields.");
	}
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new Error("Qwen device authorization response was missing a valid expires_in value.");
	}
	return {
		deviceCode,
		userCode,
		verificationUrl,
		...(verificationUrlComplete ? {} : { instructions: `Enter code: ${userCode}` }),
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
		throw new Error("Qwen token response was missing required fields.");
	}
	return {
		accessToken,
		refreshToken,
		expiresIn,
		resourceUrl: normalizeNonEmptyString(payload?.resource_url),
	};
}

function normalizeQwenBaseUrl(resourceUrl: string | undefined, fallbackBaseUrl: string): string {
	const raw = normalizeNonEmptyString(resourceUrl);
	if (!raw) {
		return fallbackBaseUrl.replace(/\/$/, "");
	}

	let normalized = raw;
	if (!/^https?:\/\//i.test(normalized)) {
		normalized = `https://${normalized}`;
	}
	const withoutTrailingSlash = normalized.replace(/\/$/, "");
	return withoutTrailingSlash.endsWith("/v1") ? withoutTrailingSlash : `${withoutTrailingSlash}/v1`;
}

function buildStoredCredentials(
	response: TokenResponse,
	dependencies: QwenOAuthProviderDependencies,
): OAuthCredentials {
	const credentials: OAuthCredentials & {
		request?: {
			baseUrl?: string;
		};
	} = {
		access: response.accessToken,
		refresh: response.refreshToken ?? response.accessToken,
		expires: dependencies.now() + response.expiresIn * 1000,
		provider: QWEN_PROVIDER_ID,
	};

	const requestBaseUrl = normalizeQwenBaseUrl(response.resourceUrl, dependencies.defaultBaseUrl);
	if (requestBaseUrl !== dependencies.defaultBaseUrl.replace(/\/$/, "")) {
		credentials.request = { baseUrl: requestBaseUrl };
	}
	return credentials;
}

async function requestDeviceCode(
	dependencies: QwenOAuthProviderDependencies,
	pkce: QwenPkcePair,
	signal: AbortSignal | undefined,
): Promise<DeviceCodeResponse> {
	const response = await fetchWithTimeout(
		dependencies.deviceCodeUrl,
		{
			method: "POST",
			headers: createFormUrlEncodedHeaders(),
			body: new URLSearchParams({
				client_id: dependencies.clientId,
				scope: dependencies.scope,
				code_challenge: pkce.challenge,
				code_challenge_method: "S256",
			}).toString(),
		},
		{
			fetchImplementation: dependencies.fetchImplementation,
			timeoutMs: dependencies.requestTimeoutMs,
			signal,
			abortMessage: QWEN_OAUTH_CANCELLED_MESSAGE,
		},
	);
	const payload = await readResponsePayload(response);
	if (!response.ok) {
		throw new Error(
			normalizeNonEmptyString(payload.json?.error_description) ??
				`Failed to initiate Qwen device authorization: ${response.status}`,
		);
	}
	return parseDeviceCodeResponse(payload.json);
}

async function requestToken(
	dependencies: QwenOAuthProviderDependencies,
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
			abortMessage: QWEN_OAUTH_CANCELLED_MESSAGE,
		},
	);
	const payload = await readResponsePayload(response);
	return { response, payload: payload.json };
}

async function pollForToken(
	dependencies: QwenOAuthProviderDependencies,
	deviceCode: DeviceCodeResponse,
	pkce: QwenPkcePair,
	signal: AbortSignal | undefined,
): Promise<TokenResponse> {
	const deadline = dependencies.now() + deviceCode.expiresIn * 1000;
	let intervalMs = Math.max(
		1_000,
		Math.floor((deviceCode.intervalSeconds ?? dependencies.pollIntervalMs / 1000) * 1000),
	);

	while (dependencies.now() < deadline) {
		throwFixedAbortErrorIfAborted(signal, QWEN_OAUTH_CANCELLED_MESSAGE);
		const { response, payload } = await requestToken(
			dependencies,
			new URLSearchParams({
				grant_type: DEVICE_CODE_GRANT_TYPE,
				client_id: dependencies.clientId,
				device_code: deviceCode.deviceCode,
				code_verifier: pkce.verifier,
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
			intervalMs = Math.min(intervalMs + 5_000, 10_000);
			await dependencies.sleep(intervalMs, signal);
			continue;
		}
		if (errorCode === "expired_token") {
			throw new Error("Qwen authorization code expired. Please try again.");
		}
		if (errorCode === "access_denied") {
			throw new Error("Qwen authorization was denied by the user.");
		}
		throw new Error(
			normalizeNonEmptyString(payload?.error_description) ??
				normalizeNonEmptyString(payload?.error) ??
				`Qwen token request failed: ${response.status}`,
		);
	}

	throw new Error("Qwen authentication timed out. Please try again.");
}

async function loginQwen(
	callbacks: OAuthLoginCallbacks,
	dependencies: QwenOAuthProviderDependencies,
): Promise<OAuthCredentials> {
	throwFixedAbortErrorIfAborted(callbacks.signal, QWEN_OAUTH_CANCELLED_MESSAGE);
	callbacks.onProgress?.("Initiating Qwen device authorization...");
	const pkce = await dependencies.generatePkcePair();
	const deviceCode = await requestDeviceCode(dependencies, pkce, callbacks.signal);
	callbacks.onAuth({
		url: deviceCode.verificationUrl,
		...(deviceCode.instructions ? { instructions: deviceCode.instructions } : {}),
	});
	callbacks.onProgress?.("Waiting for Qwen browser authorization...");
	const tokenResponse = await pollForToken(dependencies, deviceCode, pkce, callbacks.signal);
	callbacks.onProgress?.("Qwen login successful.");
	return buildStoredCredentials(tokenResponse, dependencies);
}

async function refreshQwenCredentials(
	credentials: OAuthCredentials,
	dependencies: QwenOAuthProviderDependencies,
): Promise<OAuthCredentials> {
	const refreshToken = normalizeNonEmptyString(credentials.refresh);
	if (!refreshToken) {
		throw new OAuthRefreshFailureError(
			"Qwen OAuth credentials are missing a refresh token.",
			{
				providerId: QWEN_PROVIDER_ID,
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
				"Qwen token refresh failed.",
			{
				providerId: QWEN_PROVIDER_ID,
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

export function createQwenOAuthProvider(
	dependencies: Partial<QwenOAuthProviderDependencies> = {},
): OAuthProviderInterface {
	const resolvedDependencies: QwenOAuthProviderDependencies = {
		fetchImplementation: dependencies.fetchImplementation ?? fetch,
		deviceCodeUrl:
			normalizeNonEmptyString(dependencies.deviceCodeUrl) ?? DEFAULT_QWEN_DEVICE_CODE_URL,
		tokenUrl: normalizeNonEmptyString(dependencies.tokenUrl) ?? DEFAULT_QWEN_TOKEN_URL,
		clientId: normalizeNonEmptyString(dependencies.clientId) ?? DEFAULT_QWEN_CLIENT_ID,
		scope: normalizeNonEmptyString(dependencies.scope) ?? DEFAULT_QWEN_SCOPE,
		defaultBaseUrl:
			normalizeNonEmptyString(dependencies.defaultBaseUrl) ?? DEFAULT_QWEN_BASE_URL,
		pollIntervalMs: resolvePositiveInteger(dependencies.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
		requestTimeoutMs: resolvePositiveInteger(
			dependencies.requestTimeoutMs,
			DEFAULT_REQUEST_TIMEOUT_MS,
		),
		now: dependencies.now ?? (() => Date.now()),
		sleep: dependencies.sleep ?? ((ms, signal) => createCancelableSleep(ms, signal, QWEN_OAUTH_CANCELLED_MESSAGE)),
		generatePkcePair: dependencies.generatePkcePair ?? generateDefaultPkcePair,
	};

	return {
		id: QWEN_PROVIDER_ID,
		name: QWEN_PROVIDER_NAME,
		usesCallbackServer: false,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			return loginQwen(callbacks, resolvedDependencies);
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return refreshQwenCredentials(credentials, resolvedDependencies);
		},
		getApiKey(credentials: OAuthCredentials): string {
			const accessToken = normalizeNonEmptyString(credentials.access);
			if (!accessToken) {
				throw new Error("Qwen OAuth credentials are missing an access token.");
			}
			return accessToken;
		},
	};
}

export const qwenOAuthProvider = createQwenOAuthProvider();

export function registerQwenOAuthProvider(): void {
	registerOAuthProvider(qwenOAuthProvider);
}

export function unregisterQwenOAuthProvider(): void {
	unregisterOAuthProvider(QWEN_PROVIDER_ID);
}
