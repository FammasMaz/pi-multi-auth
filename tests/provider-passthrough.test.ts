import assert from "node:assert/strict";
import test from "node:test";
import { createRotatingStreamWrapper } from "../src/provider.js";
import type { AccountManager } from "../src/account-manager.js";

test("createRotatingStreamWrapper accepts stream timeout and managed provider options", () => {
	const baseProvider = {
		api: "openai-completions" as const,
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
	const accountManager = {
		listProviderCredentialIds: async () => ["cred-1"],
	} as unknown as AccountManager;

	const wrapper = createRotatingStreamWrapper(
		"openai-codex",
		accountManager,
		baseProvider,
		new Map(),
		new Set(["hidden-provider"]),
		new Set(["openai-codex"]),
		{ attemptTimeoutMs: 60_000, idleTimeoutMs: 5_000 },
		{ LiteLLM: { attemptTimeoutMs: 0, idleTimeoutMs: 0 } },
		["LiteLLM"],
	);

	assert.equal(typeof wrapper, "function");
});