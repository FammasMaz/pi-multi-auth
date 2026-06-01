import assert from "node:assert/strict";
import test from "node:test";
import { QuotaClassifier } from "../src/quota-classifier.js";
import type { ParsedRateLimitHeaders } from "../src/types-quota.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const classifier = new QuotaClassifier();

function makeHeaders(overrides: Partial<ParsedRateLimitHeaders> = {}): ParsedRateLimitHeaders {
	return {
		limit: 100,
		remaining: 0,
		resetAt: null,
		retryAfterSeconds: null,
		resetAtFormatted: null,
		confidence: "high",
		source: "x-ratelimit-reset",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// classifyFromHeaders
// ---------------------------------------------------------------------------

test("classifyFromHeaders returns hourly for <2h resetAt with high confidence", () => {
	const now = Date.now();
	const result = classifier.classifyFromHeaders(
		makeHeaders({
			resetAt: now + 60 * 60 * 1000, // 1 hour
			confidence: "high",
		}),
	);
	assert.equal(result.classification, "hourly");
	assert.equal(result.source, "header");
	assert.equal(result.confidence, "high");
	assert.ok(result.window !== undefined);
	assert.equal(result.window.classification, "hourly");
	assert.ok(result.window.resetInMs > 0);
});

test("classifyFromHeaders returns daily for 2-36h resetAt", () => {
	const now = Date.now();
	const result = classifier.classifyFromHeaders(
		makeHeaders({
			resetAt: now + 24 * 60 * 60 * 1000, // 24 hours
		}),
	);
	assert.equal(result.classification, "daily");
	assert.ok(result.window !== undefined);
});

test("classifyFromHeaders returns unknown when resetAt is null", () => {
	const result = classifier.classifyFromHeaders(
		makeHeaders({ resetAt: null }),
	);
	assert.equal(result.classification, "unknown");
	assert.equal(result.window, undefined);
});

test("classifyFromHeaders returns unknown when remaining > 0 and no meaningful resetAt", () => {
	const result = classifier.classifyFromHeaders(
		makeHeaders({
			remaining: 5,
			resetAt: null,
		}),
	);
	assert.equal(result.classification, "unknown");
});

test("classifyFromHeaders uses medium confidence when confidence is not high", () => {
	const now = Date.now();
	const result = classifier.classifyFromHeaders(
		makeHeaders({
			resetAt: now + 30 * 60 * 1000,
			confidence: "low",
		}),
	);
	assert.equal(result.confidence, "medium");
});

test("classifyFromHeaders returns weekly for 7-day resetAt", () => {
	const now = Date.now();
	const result = classifier.classifyFromHeaders(
		makeHeaders({
			resetAt: now + 7 * 24 * 60 * 60 * 1000,
		}),
	);
	assert.equal(result.classification, "weekly");
});

test("classifyFromHeaders returns monthly for 30-day resetAt", () => {
	const now = Date.now();
	const result = classifier.classifyFromHeaders(
		makeHeaders({
			resetAt: now + 30 * 24 * 60 * 60 * 1000,
		}),
	);
	assert.equal(result.classification, "monthly");
});

test("classifyFromHeaders returns unknown for non-finite resetAt", () => {
	const result = classifier.classifyFromHeaders(
		makeHeaders({ resetAt: NaN }),
	);
	assert.equal(result.classification, "unknown");
});

// ---------------------------------------------------------------------------
// classifyFromMessage
// ---------------------------------------------------------------------------

test("classifyFromMessage detects balance patterns with high confidence", () => {
	const result = classifier.classifyFromMessage("HTTP 402 Payment Required");
	assert.equal(result.classification, "balance");
	assert.equal(result.confidence, "high");
	assert.equal(result.source, "message");
	assert.equal(result.recoveryAction.action, "pay");
	assert.equal(result.recoveryAction.requiresManual, true);
});

test("classifyFromMessage detects organization disabled patterns", () => {
	const result = classifier.classifyFromMessage("This organization has been disabled");
	assert.equal(result.classification, "organization");
	assert.equal(result.confidence, "high");
	assert.equal(result.recoveryAction.action, "contact_support");
});

test("classifyFromMessage detects balance via insufficient balance", () => {
	const result = classifier.classifyFromMessage("insufficient balance");
	assert.equal(result.classification, "balance");
});

test("classifyFromMessage detects balance via add funds", () => {
	const result = classifier.classifyFromMessage("please add funds to continue");
	assert.equal(result.classification, "balance");
});

test("classifyFromMessage detects hourly rate limit via message", () => {
	const result = classifier.classifyFromMessage("Rate limit exceeded. Try again in 2 minutes");
	// "Try again in 2 minutes" triggers the Retry-After parser first,
	// which classifies 2 minutes as hourly with high confidence.
	assert.equal(result.classification, "hourly");
	assert.equal(result.confidence, "high");
	assert.equal(result.source, "message");
	assert.ok(result.cooldownMs > 0);
});

test("classifyFromMessage detects daily limit via message", () => {
	const result = classifier.classifyFromMessage("Daily limit reached. Try again tomorrow");
	assert.equal(result.classification, "daily");
	assert.equal(result.confidence, "high");
});

test("classifyFromMessage detects weekly limit via message", () => {
	const result = classifier.classifyFromMessage("Weekly limit exceeded");
	assert.equal(result.classification, "weekly");
});

test("classifyFromMessage detects monthly limit via message", () => {
	const result = classifier.classifyFromMessage("Monthly billing cycle limit reached");
	assert.equal(result.classification, "monthly");
});

test("classifyFromMessage falls back to unknown with low confidence when no pattern matches", () => {
	const result = classifier.classifyFromMessage("Some random error message");
	assert.equal(result.classification, "unknown");
	assert.equal(result.confidence, "low");
	assert.equal(result.source, "default");
});

test("classifyFromMessage uses header result when confidence is high", () => {
	const now = Date.now();
	const result = classifier.classifyFromMessage(
		"Some error",
		makeHeaders({
			resetAt: now + 30 * 60 * 1000,
			confidence: "high",
		}),
	);
	assert.equal(result.classification, "hourly");
	assert.equal(result.source, "header");
});

test("classifyFromMessage prefers balance/organization over header when header is not high confidence", () => {
	const now = Date.now();
	const result = classifier.classifyFromMessage(
		"Insufficient balance. HTTP 402",
		makeHeaders({
			resetAt: now + 30 * 60 * 1000,
			confidence: "low",
		}),
	);
	assert.equal(result.classification, "balance");
});

test("classifyFromMessage detects Cloudflare daily reset pattern", () => {
	const result = classifier.classifyFromMessage(
		"You used up your daily free allocation. 10,000 neurons per day.",
	);
	assert.equal(result.classification, "daily");
	assert.ok(result.window !== undefined);
	assert.equal(result.window.classification, "daily");
});

test("classifyFromMessage detects try again tomorrow as daily", () => {
	const result = classifier.classifyFromMessage("Please try again tomorrow");
	assert.equal(result.classification, "daily");
});

test("classifyFromMessage detects per day as daily", () => {
	const result = classifier.classifyFromMessage("Only 100 requests per day");
	assert.equal(result.classification, "daily");
});

// ---------------------------------------------------------------------------
// classifyFromUsage
// ---------------------------------------------------------------------------

test("classifyFromUsage uses header result when classification is known", () => {
	const now = Date.now();
	const result = classifier.classifyFromUsage(
		null,
		null,
		makeHeaders({
			resetAt: now + 60 * 60 * 1000,
			confidence: "high",
		}),
	);
	assert.equal(result.classification, "hourly");
	assert.equal(result.source, "header");
});

test("classifyFromUsage ignores header when classification is unknown", () => {
	const result = classifier.classifyFromUsage(
		null,
		null,
		makeHeaders({ resetAt: null }),
	);
	assert.equal(result.classification, "unknown");
});

test("classifyFromUsage uses secondary window before primary", () => {
	const now = Date.now();
	const result = classifier.classifyFromUsage(
		{ usedPercent: 100, windowMinutes: 10_080, resetsAt: null }, // weekly
		{ usedPercent: 100, windowMinutes: 60, resetsAt: null },      // hourly
	);
	// secondary (hourly) should be used first
	assert.equal(result.classification, "hourly");
});

test("classifyFromUsage returns unknown when both windows are null", () => {
	const result = classifier.classifyFromUsage(null, null);
	assert.equal(result.classification, "unknown");
	assert.equal(result.confidence, "low");
});

test("classifyFromUsage uses primary window when secondary has no classification", () => {
	const result = classifier.classifyFromUsage(
		{ usedPercent: 100, windowMinutes: 60, resetsAt: null }, // hourly
		null,
	);
	assert.equal(result.classification, "hourly");
});

test("classifyFromUsage returns unknown when window usedPercent < 100", () => {
	const result = classifier.classifyFromUsage(
		{ usedPercent: 50, windowMinutes: 60, resetsAt: null },
		null,
	);
	assert.equal(result.classification, "unknown");
});

// ---------------------------------------------------------------------------
// shouldDisableCredential
// ---------------------------------------------------------------------------

test("shouldDisableCredential returns true for balance", () => {
	assert.equal(classifier.shouldDisableCredential("balance"), true);
});

test("shouldDisableCredential returns true for organization", () => {
	assert.equal(classifier.shouldDisableCredential("organization"), true);
});

test("shouldDisableCredential returns false for hourly", () => {
	assert.equal(classifier.shouldDisableCredential("hourly"), false);
});

test("shouldDisableCredential returns false for daily", () => {
	assert.equal(classifier.shouldDisableCredential("daily"), false);
});

test("shouldDisableCredential returns false for weekly", () => {
	assert.equal(classifier.shouldDisableCredential("weekly"), false);
});

test("shouldDisableCredential returns false for monthly", () => {
	assert.equal(classifier.shouldDisableCredential("monthly"), false);
});

test("shouldDisableCredential returns false for unknown", () => {
	assert.equal(classifier.shouldDisableCredential("unknown"), false);
});

// ---------------------------------------------------------------------------
// getRecoveryAction
// ---------------------------------------------------------------------------

test("getRecoveryAction returns wait for hourly", () => {
	const action = classifier.getRecoveryAction("hourly");
	assert.equal(action.action, "wait");
	assert.equal(action.requiresManual, false);
});

test("getRecoveryAction returns pay for balance", () => {
	const action = classifier.getRecoveryAction("balance");
	assert.equal(action.action, "pay");
	assert.equal(action.requiresManual, true);
});

test("getRecoveryAction returns contact_support for organization", () => {
	const action = classifier.getRecoveryAction("organization");
	assert.equal(action.action, "contact_support");
});

// ---------------------------------------------------------------------------
// requiresManualIntervention
// ---------------------------------------------------------------------------

test("requiresManualIntervention returns true for balance", () => {
	assert.equal(classifier.requiresManualIntervention("balance"), true);
});

test("requiresManualIntervention returns true for organization", () => {
	assert.equal(classifier.requiresManualIntervention("organization"), true);
});

test("requiresManualIntervention returns false for hourly", () => {
	assert.equal(classifier.requiresManualIntervention("hourly"), false);
});

// ---------------------------------------------------------------------------
// createQuotaState
// ---------------------------------------------------------------------------

test("createQuotaState builds correct QuotaStateForCredential", () => {
	const detectedAt = 1_000_000;
	const result = classifier.createQuotaState(
		"cred1",
		"Rate limit exceeded",
		{
			classification: "hourly",
			cooldownMs: 60 * 60 * 1000,
			recoveryAction: {
				action: "wait",
				requiresManual: false,
				estimatedWaitMs: 60 * 60 * 1000,
				description: "Wait for the hourly rate limit to reset.",
			},
			confidence: "medium",
			source: "message",
		},
		detectedAt,
	);
	assert.equal(result.credentialId, "cred1");
	assert.equal(result.classification, "hourly");
	assert.equal(result.detectedAt, detectedAt);
	assert.equal(result.errorMessage, "Rate limit exceeded");
	assert.equal(result.recoveryAction.action, "wait");
});

test("createQuotaState uses fallback error message when empty", () => {
	const result = classifier.createQuotaState(
		"cred1",
		"",
		{
			classification: "balance",
			cooldownMs: Number.POSITIVE_INFINITY,
			recoveryAction: {
				action: "pay",
				requiresManual: true,
				description: "Add balance or credits.",
			},
			confidence: "high",
			source: "message",
		},
		1000,
	);
	assert.equal(result.errorMessage, "Quota state recorded");
});

test("createQuotaState includes resetAt from window", () => {
	const windowEndMs = 5_000_000;
	const result = classifier.createQuotaState(
		"cred1",
		"Test",
		{
			classification: "daily",
			window: {
				classification: "daily",
				windowStartMs: 1000,
				windowEndMs,
				resetInMs: windowEndMs - 1000,
				resetAtFormatted: new Date(windowEndMs).toISOString(),
			},
			cooldownMs: 24 * 60 * 60 * 1000,
			recoveryAction: {
				action: "wait",
				requiresManual: false,
				estimatedWaitMs: 24 * 60 * 60 * 1000,
				description: "Wait for daily quota reset.",
			},
			confidence: "high",
			source: "header",
		},
		1000,
	);
	assert.equal(result.resetAt, windowEndMs);
});
