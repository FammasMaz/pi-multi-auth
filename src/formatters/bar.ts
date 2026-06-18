/**
 * Formats reset time as a relative countdown.
 */
export function formatResetCountdown(resetAt: number | null): string {
	if (!resetAt) {
		return "n/a";
	}

	const resetMs = resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
	const deltaMs = resetMs - Date.now();
	if (deltaMs <= 0) {
		return "now";
	}

	const minutes = Math.max(1, Math.round(deltaMs / 60_000));
	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}

	const days = Math.round(hours / 24);
	return `${days}d`;
}
