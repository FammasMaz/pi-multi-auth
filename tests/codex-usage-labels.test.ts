import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexGlobalCreditLines, resolveUsageWindowLabel } from "../src/commands.js";
import { getCodexWindowCredits } from "../src/usage/codex.js";
import type { CredentialStatus } from "../src/types.js";
import type { UsageSnapshot } from "../src/usage/types.js";

function createSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	const now = Date.now();
	return {
		timestamp: now,
		provider: "openai-codex",
		planType: "ChatGPT Plus",
		primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Math.ceil((now + 300 * 60_000) / 1000) },
		secondary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: Math.ceil((now + 10_080 * 60_000) / 1000) },
		credits: null,
		copilotQuota: null,
		updatedAt: now,
		...overrides,
	};
}

test("usage window labels derive from quota metadata instead of provider hardcodes", () => {
	const snapshot = createSnapshot();

	assert.equal(resolveUsageWindowLabel(snapshot, "primary"), "5-hour window");
	assert.equal(resolveUsageWindowLabel(snapshot, "secondary"), "7-day window");
});

test("usage window labels disambiguate matching duration windows generically", () => {
	const snapshot = createSnapshot({
		provider: "anthropic",
		secondary: { usedPercent: 20, windowMinutes: 300, resetsAt: null },
	});

	assert.equal(resolveUsageWindowLabel(snapshot, "primary"), "5-hour window (window 1)");
	assert.equal(resolveUsageWindowLabel(snapshot, "secondary"), "5-hour window (window 2)");
});

test("Codex global credit lines aggregate visible account capacity", () => {
	const snapshot = createSnapshot({
		credits: { hasCredits: true, unlimited: false, balance: "12" },
	});
	const credential = {
		credentialId: "openai-codex",
		usageSnapshot: snapshot,
	} as CredentialStatus;

	assert.deepEqual(buildCodexGlobalCreditLines([credential]), [
		"5h pool: 203/225 remaining (90% left, 1 acct)",
		"7d pool: 6,048/7,560 remaining (80% left, 1 acct)",
		"Upstream balance: 12 credits",
	]);
});

test("Codex credit helper treats weekly-only primary rows as secondary capacity", () => {
	const snapshot = createSnapshot({
		planType: "free",
		primary: { usedPercent: 50, windowMinutes: 10_080, resetsAt: null },
		secondary: null,
	});

	assert.equal(getCodexWindowCredits(snapshot, "primary"), null);
	assert.deepEqual(getCodexWindowCredits(snapshot, "secondary"), {
		capacity: 1134,
		used: 567,
		remaining: 567,
		usedPercent: 50,
		windowMinutes: 10_080,
		resetsAt: null,
	});
});

test("Codex free 30-day primary rows are shown as secondary 30d capacity", () => {
	const snapshot = createSnapshot({
		planType: "free",
		primary: { usedPercent: 50, windowMinutes: 43_200, resetsAt: null },
		secondary: null,
	});
	const credential = {
		credentialId: "openai-codex-free",
		usageSnapshot: snapshot,
	} as CredentialStatus;

	assert.equal(getCodexWindowCredits(snapshot, "primary"), null);
	assert.deepEqual(getCodexWindowCredits(snapshot, "secondary"), {
		capacity: 1134,
		used: 567,
		remaining: 567,
		usedPercent: 50,
		windowMinutes: 43_200,
		resetsAt: null,
	});
	assert.deepEqual(buildCodexGlobalCreditLines([credential]), [
		"30d pool: 567/1,134 remaining (50% left, 1 acct)",
	]);
});
