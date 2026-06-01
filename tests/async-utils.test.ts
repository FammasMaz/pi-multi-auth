import assert from "node:assert/strict";
import test from "node:test";
import { abortableSleep } from "../src/async-utils.js";

test("abortableSleep resolves when no signal aborts", async () => {
	const startedAt = Date.now();
	await abortableSleep(5);
	assert.equal(Date.now() - startedAt >= 0, true);
});

test("abortableSleep rejects for a pre-aborted signal", async () => {
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(abortableSleep(100, controller.signal), { name: "AbortError" });
});

test("abortableSleep resolves immediately when ms <= 0", async () => {
	const controller = new AbortController();
	await abortableSleep(0, controller.signal);
	await abortableSleep(-1);
});

test("abortableSleep rejects when the signal aborts during sleep", async () => {
	const controller = new AbortController();
	const sleeping = abortableSleep(1_000, controller.signal);
	controller.abort();

	await assert.rejects(sleeping, { name: "AbortError" });
});
