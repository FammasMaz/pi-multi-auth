import assert from "node:assert/strict";
import test from "node:test";

import { discoverCloudflareWorkersAiBaseUrl } from "../src/cloudflare-account-discovery.js";

function createAbortError(): Error {
	const error = new Error("The operation was aborted.");
	error.name = "AbortError";
	return error;
}

test("Cloudflare Workers AI account discovery times out when no caller signal is provided", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let receivedSignal = false;
	globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			receivedSignal = signal instanceof AbortSignal;
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
		() => discoverCloudflareWorkersAiBaseUrl("cf-timeout-test-token", { timeoutMs: 5 }),
		/Cloudflare account discovery timed out after 5ms/,
	);
	assert.equal(receivedSignal, true);
});
