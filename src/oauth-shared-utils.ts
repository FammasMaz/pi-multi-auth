/**
 * Shared OAuth utility helpers extracted from individual provider modules.
 * Reduces duplication across device-code and OAuth provider modules.
 */
import { createAbortError, isRecord } from "./auth-error-utils.js";

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export function resolvePositiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

export function parseJsonRecord(text: string): Record<string, unknown> | null {
	if (!text.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export async function readResponsePayload(response: Response): Promise<{
	text: string;
	json: Record<string, unknown> | null;
}> {
	const text = await response.text().catch(() => "");
	return {
		text,
		json: parseJsonRecord(text),
	};
}

export async function createCancelableSleep(
	ms: number,
	signal?: AbortSignal,
	abortMessage?: string,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError(abortMessage ?? "Operation was cancelled."));
			return;
		}

		const onAbort = (): void => {
			clearTimeout(timeout);
			reject(createAbortError(abortMessage ?? "Operation was cancelled."));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function createFormUrlEncodedHeaders(): HeadersInit {
	return {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
}

export function createJsonHeaders(): HeadersInit {
	return {
		"Content-Type": "application/json",
		Accept: "application/json",
	};
}

export function toBase64Url(value: Uint8Array): string {
	return Buffer.from(value)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}
