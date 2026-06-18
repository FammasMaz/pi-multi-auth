import assert from "node:assert/strict";
import test from "node:test";
import { RetryBudget } from "../src/balancer/retry-budget.js";

test("RetryBudget isolates providers and exhausts per window", () => {
	let now = 1_000;
	const budget = new RetryBudget({ maxRetriesPerWindow: 2, windowMs: 1_000, now: () => now });

	assert.equal(budget.tryAcquire("provider-a"), true);
	assert.equal(budget.tryAcquire("provider-a"), true);
	assert.equal(budget.tryAcquire("provider-a"), false);
	assert.equal(budget.tryAcquire("provider-b"), true);

	now += 1_001;
	assert.equal(budget.tryAcquire("provider-a"), true);
});

test("RetryBudget recordSuccess resets provider attempts", () => {
	const budget = new RetryBudget({ maxRetriesPerWindow: 1, windowMs: 60_000 });

	assert.equal(budget.tryAcquire("provider"), true);
	assert.equal(budget.tryAcquire("provider"), false);
	budget.recordSuccess("provider");
	assert.equal(budget.tryAcquire("provider"), true);
});

test("RetryBudget getRemaining returns intermediate count after partial consumption", () => {
	let now = 1_000;
	const budget = new RetryBudget({ maxRetriesPerWindow: 3, windowMs: 1_000, now: () => now });

	assert.equal(budget.getRemaining("provider"), 3);
	assert.equal(budget.tryAcquire("provider"), true);
	assert.equal(budget.getRemaining("provider"), 2);
	assert.equal(budget.tryAcquire("provider"), true);
	assert.equal(budget.getRemaining("provider"), 1);

	budget.recordSuccess("provider");
	assert.equal(budget.getRemaining("provider"), 3);
});

test("RetryBudget fast-fails when configured with zero retries", () => {
	const budget = new RetryBudget({ maxRetriesPerWindow: 0, windowMs: 60_000 });

	assert.equal(budget.tryAcquire("provider"), false);
	assert.equal(budget.getRemaining("provider"), 0);
});
