import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sleep } from "./async-utils.js";
import { getErrorMessage, toError } from "./auth-error-utils.js";
import { isRetryableFileAccessError } from "./file-retry.js";

export type LockRetryOptions = {
	retries: number;
	factor: number;
	minTimeout: number;
	maxTimeout: number;
	randomize: boolean;
};

export type FileLockOptions = {
	realpath?: boolean;
	retries: LockRetryOptions;
	stale: number;
	onCompromised?: (error: Error) => void;
};

type FileLockAttemptDetails = {
	filePath: string;
	lockPath: string;
	attempt: number;
	maxAttempts: number;
	staleMs: number;
};

export type FileLockRetryDetails = FileLockAttemptDetails & {
	delayMs: number;
	error: string;
};

export type FileLockErrorDetails = FileLockAttemptDetails & {
	error: string;
};

export type FileLockStaleDetails = FileLockAttemptDetails & {
	ageMs: number;
};

export type FileLockObserver = {
	onRetry?: (delayMs: number, details: FileLockRetryDetails) => void;
	onAcquired?: (latencyMs: number, details: FileLockAttemptDetails) => void;
	onRetryableAccessError?: (details: FileLockErrorDetails) => void;
	onError?: (details: FileLockErrorDetails) => void;
	onStaleLockRemoved?: (details: FileLockStaleDetails) => void;
	onTimeout?: (details: FileLockErrorDetails) => void;
};

export function lockDirPath(filePath: string): string {
	return `${filePath}.lock`;
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function ensureParentDir(filePath: string): Promise<void> {
	const parentDir = dirname(filePath);
	if (!(await pathExists(parentDir))) {
		await mkdir(parentDir, { recursive: true, mode: 0o700 });
	}
}

export async function hardenCredentialFilePermissions(filePath: string): Promise<void> {
	if (process.platform === "win32") {
		return;
	}

	try {
		await chmod(filePath, 0o600);
	} catch (error: unknown) {
		const maybeCode = (error as Error & { code?: unknown }).code;
		const hardenedError = new Error(
			`Failed to harden credential file permissions for '${filePath}': ${getErrorMessage(error)}`,
			{ cause: error },
		) as Error & { code?: string };
		if (typeof maybeCode === "string") {
			hardenedError.code = maybeCode;
		}
		throw hardenedError;
	}
}

export async function ensureFileExists(filePath: string, content: string): Promise<void> {
	if (!(await pathExists(filePath))) {
		await writeFile(filePath, content, "utf-8");
		await hardenCredentialFilePermissions(filePath);
	}
}

export async function acquireFileLock(
	filePath: string,
	options: FileLockOptions,
	observer: FileLockObserver = {},
): Promise<() => Promise<void>> {
	const lockPath = lockDirPath(filePath);
	const maxAttempts = Math.max(0, options.retries.retries) + 1;
	const startedAt = Date.now();

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const details: FileLockAttemptDetails = {
			filePath,
			lockPath,
			attempt,
			maxAttempts,
			staleMs: options.stale,
		};
		try {
			await mkdir(lockPath, { mode: 0o700 });
			observer.onAcquired?.(Date.now() - startedAt, details);
			return async () => {
				await rm(lockPath, { recursive: true, force: true });
			};
		} catch (error) {
			const lockError = toError(error);
			const maybeCode = (lockError as Error & { code?: unknown }).code;
			const isExistingLockError = maybeCode === "EEXIST";
			const isRetryableAccessError = isRetryableFileAccessError(lockError);

			if (!isExistingLockError && !isRetryableAccessError) {
				observer.onError?.({ ...details, error: lockError.message });
				throw lockError;
			}

			if (!isExistingLockError) {
				observer.onRetryableAccessError?.({ ...details, error: lockError.message });
			}

			try {
				const lockStats = await stat(lockPath);
				const ageMs = Date.now() - lockStats.mtimeMs;
				if (ageMs > options.stale) {
					await rm(lockPath, { recursive: true, force: true });
					observer.onStaleLockRemoved?.({ ...details, ageMs: Math.round(ageMs) });
					if (options.onCompromised) {
						options.onCompromised(
							new Error(`Removed stale lock '${lockPath}' older than ${Math.round(ageMs)}ms.`),
						);
					}
					// Decrement attempt so we retry the mkdir immediately after removing stale lock.
					attempt -= 1;
					continue;
				}
			} catch {
				// Lock may be released while checking staleness; retry.
			}

			if (attempt >= maxAttempts) {
				observer.onTimeout?.({ ...details, error: lockError.message });
				throw new Error(
					`Timed out acquiring lock for '${filePath}' after ${maxAttempts} attempt(s): ${lockError.message}`,
				);
			}

			const baseDelay = Math.min(
				options.retries.maxTimeout,
				Math.max(
					options.retries.minTimeout,
					Math.round(options.retries.minTimeout * Math.pow(options.retries.factor, attempt - 1)),
				),
			);
			const delay = options.retries.randomize
				? Math.round(baseDelay * (0.5 + Math.random()))
				: baseDelay;
			observer.onRetry?.(delay, { ...details, delayMs: delay, error: lockError.message });
			await sleep(delay);
		}
	}

	throw new Error(`Failed to acquire lock for '${filePath}'.`);
}
