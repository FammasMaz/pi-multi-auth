import assert from "node:assert/strict";
import test from "node:test";

import { anthropicUsageProvider } from "../src/usage/anthropic.js";

function createAbortError(): Error {
	const error = new Error("The operation was aborted.");
	error.name = "AbortError";
	return error;
}

test("anthropic usage provider fails explicitly when usage fetch times out", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) {
				reject(createAbortError());
				return;
			}
			signal?.addEventListener(
				"abort",
				() => {
					reject(createAbortError());
				},
				{ once: true },
			);
		})) as typeof fetch;

	await assert.rejects(
		() => anthropicUsageProvider.fetchUsage!({ accessToken: "anthropic-timeout-test-token" }),
		/Anthropic usage request timed out after 3000ms/,
	);
});
