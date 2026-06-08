import type { CredentialErrorKind } from "./error-classifier.js";

/**
 * Errors produced when every credential failed for one request. These must never
 * be persisted as a single-credential disable reason.
 */
const ROTATION_SUMMARY_PREFIXES = [
	/^All credentials are unavailable\b/i,
	/^Delegated credential is unavailable\b/i,
	/^Multi-auth rotation failed\b/i,
	/^All \d+ rotated credential\(s\)/i,
];

/** Account- or token-level revocation that should stay disabled until manual review. */
const ACCOUNT_BANNED_OR_REVOKED_PATTERNS: RegExp[] = [
	/(?:^|[^\p{L}\p{N}])token[_-]?(?:revoked|invalidated)(?:$|[^\p{L}\p{N}])/iu,
	/(?:auth(?:entication)?|access|oauth)\s+token[^\n.]*(?:invalidated|revoked)/i,
	/encountered invalidated oauth token/i,
	/this organization has been disabled/i,
	/organization has been disabled/i,
	/account\s+(?:has been |is )?(?:suspended|disabled|banned|deactivated|terminated)/i,
	/user\s+(?:has been |is )?(?:suspended|disabled|banned|deactivated)/i,
	/access\s+(?:has been |is )?disabled/i,
	/(?:chatgpt|openai)\s+account[^\n.]*(?:suspended|disabled|banned)/i,
];

const REAUTH_ONLY_PATTERNS: RegExp[] = [
	/provided authentication token is expired/i,
	/access token expired/i,
	/expired\s+(?:token|session|credential)/i,
	/refresh_token_reused/i,
	/invalid[_-]?grant/i,
	/refresh token[^\n.]*(?:expired|revoked|invalid)/i,
	/please try signing in again/i,
	/try\s+signing\s+in\s+again/i,
	/sign in again/i,
];

export function isRotationSummaryError(message: string): boolean {
	const normalized = message.trim();
	if (!normalized) {
		return false;
	}
	return ROTATION_SUMMARY_PREFIXES.some((pattern) => pattern.test(normalized));
}

export function isAccountBannedOrRevokedError(message: string): boolean {
	const normalized = message.trim();
	if (!normalized) {
		return false;
	}
	if (isRotationSummaryError(normalized)) {
		return false;
	}
	return ACCOUNT_BANNED_OR_REVOKED_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isReauthOnlyError(message: string): boolean {
	const normalized = message.trim();
	if (!normalized) {
		return false;
	}
	return REAUTH_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Only these failures should persist a credential in disabledCredentials.
 * Expired tokens, refresh reuse, quotas, and rotation summaries are not bans.
 */
export function shouldPermanentlyDisableCredential(
	message: string,
	kind: CredentialErrorKind,
): boolean {
	const normalized = message.trim();
	if (!normalized || isRotationSummaryError(normalized)) {
		return false;
	}
	if (isReauthOnlyError(normalized)) {
		return false;
	}
	if (isAccountBannedOrRevokedError(normalized)) {
		return true;
	}
	if (kind === "organization_disabled" || kind === "balance_exhausted") {
		return true;
	}
	return false;
}