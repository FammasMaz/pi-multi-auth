import assert from "node:assert/strict";
import test from "node:test";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { AccountManager } from "../src/account-manager.js";
import { createRotatingStreamWrapper } from "../src/provider.js";

const GROK_MODEL: Model<Api> = {
	id: "grok-composer-2.5-fast",
	name: "Composer 2.5",
	api: "openai-responses",
	provider: "grok-cli",
	baseUrl: "https://cli-chat-proxy.grok.com/v1",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 200_000,
	maxTokens: 16_384,
};

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function createDoneMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("rotating API wrapper passes unmanaged extension providers through unchanged", async () => {
	let acquireCalls = 0;
	let forwardedOptions: SimpleStreamOptions | undefined;
	const accountManager = {
		acquireCredential: async () => {
			acquireCalls += 1;
			throw new Error("unmanaged providers should not acquire multi-auth credentials");
		},
		listProviderCredentialIds: async () => [],
	} as unknown as AccountManager;
	const baseProvider = {
		api: "openai-responses" as Api,
		stream: () => createAssistantMessageEventStream(),
		streamSimple: (
			model: Model<Api>,
			_context: Context,
			options?: SimpleStreamOptions,
		) => {
			forwardedOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createDoneMessage(model);
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		},
	};
	const wrapper = createRotatingStreamWrapper(
		"openai-codex",
		accountManager,
		baseProvider,
		new Map(),
		new Set(),
		new Set(["openai-codex"]),
	);
	const events: AssistantMessageEvent[] = [];
	const stream = wrapper(
		GROK_MODEL,
		{ messages: [] },
		{
			apiKey: "grok-provider-owned-token",
			headers: {
				"X-XAI-Token-Auth": "xai-grok-cli",
				"x-grok-model-override": GROK_MODEL.id,
			},
		},
	);

	for await (const event of stream) {
		events.push(event);
	}

	assert.equal(acquireCalls, 0);
	assert.equal(forwardedOptions?.apiKey, "grok-provider-owned-token");
	assert.equal(forwardedOptions?.headers?.["X-XAI-Token-Auth"], "xai-grok-cli");
	assert.equal(forwardedOptions?.headers?.["x-grok-model-override"], GROK_MODEL.id);
	assert.equal(events.at(-1)?.type, "done");
});
