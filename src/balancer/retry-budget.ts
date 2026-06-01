export interface RetryBudgetOptions {
	maxRetriesPerWindow: number;
	windowMs: number;
	now?: () => number;
}

export class RetryBudget {
	private readonly maxRetriesPerWindow: number;
	private readonly windowMs: number;
	private readonly now: () => number;
	private readonly attemptsByProvider = new Map<string, number[]>();

	constructor(options: RetryBudgetOptions) {
		this.maxRetriesPerWindow = Math.max(0, Math.trunc(options.maxRetriesPerWindow));
		this.windowMs = Math.max(1, Math.trunc(options.windowMs));
		this.now = options.now ?? Date.now;
	}

	tryAcquire(providerId: string): boolean {
		const normalizedProviderId = providerId.trim();
		if (!normalizedProviderId || this.maxRetriesPerWindow <= 0) {
			return false;
		}

		const currentTime = this.now();
		const attempts = this.getActiveAttempts(normalizedProviderId, currentTime);
		if (attempts.length >= this.maxRetriesPerWindow) {
			this.attemptsByProvider.set(normalizedProviderId, attempts);
			return false;
		}

		attempts.push(currentTime);
		this.attemptsByProvider.set(normalizedProviderId, attempts);
		return true;
	}

	recordSuccess(providerId: string): void {
		const normalizedProviderId = providerId.trim();
		if (normalizedProviderId) {
			this.attemptsByProvider.delete(normalizedProviderId);
		}
	}

	getRemaining(providerId: string): number {
		const normalizedProviderId = providerId.trim();
		if (!normalizedProviderId) {
			return 0;
		}
		const attempts = this.getActiveAttempts(normalizedProviderId, this.now());
		this.attemptsByProvider.set(normalizedProviderId, attempts);
		return Math.max(0, this.maxRetriesPerWindow - attempts.length);
	}

	private getActiveAttempts(providerId: string, now: number): number[] {
		const cutoff = now - this.windowMs;
		return (this.attemptsByProvider.get(providerId) ?? []).filter((attemptedAt) => attemptedAt > cutoff);
	}
}
