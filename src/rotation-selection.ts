import type { ProviderRotationState } from "./types.js";

export const QUOTA_ERROR_DECAY_WINDOW_MS = 60_000;
export const QUOTA_ERROR_PROBE_SUCCESS_STREAK_REQUIRED = 3;

type UsageBasedRotationRankState = Pick<
	ProviderRotationState,
	"credentialIds" | "usageCount" | "quotaErrorCount" | "lastUsedAt"
> &
	Partial<Pick<ProviderRotationState, "quotaErrorLastSeenAt" | "quotaRecoverySuccessCount" | "quotaStates">>;

function readNonNegativeNumber(
	record: Readonly<Record<string, number>> | undefined,
	key: string,
): number {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readQuotaErrorObservedAt(
	state: UsageBasedRotationRankState,
	credentialId: string,
): number | null {
	const candidates = [
		state.quotaErrorLastSeenAt?.[credentialId],
		state.quotaStates?.[credentialId]?.detectedAt,
	].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);

	return candidates.length > 0 ? Math.max(...candidates) : null;
}

export function getEffectiveQuotaErrorCount(
	state: UsageBasedRotationRankState,
	credentialId: string,
	now: number = Date.now(),
): number {
	const rawCount = readNonNegativeNumber(state.quotaErrorCount, credentialId);
	if (rawCount <= 0) {
		return 0;
	}

	const observedAt = readQuotaErrorObservedAt(state, credentialId);
	if (observedAt === null) {
		return 0;
	}

	const ageMs = Math.max(0, now - observedAt);
	if (ageMs >= QUOTA_ERROR_DECAY_WINDOW_MS) {
		return 0;
	}

	const successCount = readNonNegativeNumber(state.quotaRecoverySuccessCount, credentialId);
	if (successCount >= QUOTA_ERROR_PROBE_SUCCESS_STREAK_REQUIRED) {
		return 0;
	}

	const timeDecayFactor = Math.max(0, 1 - ageMs / QUOTA_ERROR_DECAY_WINDOW_MS);
	const successRecoveryFactor = Math.max(
		0,
		1 - successCount / QUOTA_ERROR_PROBE_SUCCESS_STREAK_REQUIRED,
	);
	return rawCount * timeDecayFactor * successRecoveryFactor;
}

/**
 * Resolves the next eligible credential index for round-robin rotation.
 */
export function getRoundRobinCandidateIndex(
	state: Pick<ProviderRotationState, "credentialIds" | "activeIndex">,
	available: ReadonlySet<string>,
): number | undefined {
	if (state.credentialIds.length === 0) {
		return undefined;
	}

	for (let offset = 0; offset < state.credentialIds.length; offset += 1) {
		const index = (state.activeIndex + offset) % state.credentialIds.length;
		const credentialId = state.credentialIds[index];
		if (available.has(credentialId)) {
			return index;
		}
	}

	return undefined;
}

/**
 * Resolves the next eligible credential index for usage-based rotation.
 */
export function getUsageBasedCandidateIndex(
	state: UsageBasedRotationRankState,
	available: ReadonlySet<string>,
	now: number = Date.now(),
): number | undefined {
	const candidates = state.credentialIds
		.map((credentialId, index) => ({
			credentialId,
			index,
			usageCount: state.usageCount[credentialId] ?? 0,
			quotaErrorCount: getEffectiveQuotaErrorCount(state, credentialId, now),
			lastUsedAt: state.lastUsedAt[credentialId] ?? 0,
		}))
		.filter((item) => available.has(item.credentialId))
		.sort((left, right) => {
			if (left.quotaErrorCount !== right.quotaErrorCount) {
				return left.quotaErrorCount - right.quotaErrorCount;
			}
			if (left.usageCount !== right.usageCount) {
				return left.usageCount - right.usageCount;
			}
			if (left.lastUsedAt !== right.lastUsedAt) {
				return right.lastUsedAt - left.lastUsedAt;
			}
			return left.index - right.index;
		});

	return candidates[0]?.index;
}
