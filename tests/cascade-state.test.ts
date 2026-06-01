import assert from "node:assert/strict";
import test from "node:test";
import { CascadeStateManager } from "../src/cascade-state.js";

test("CascadeStateManager reserves only one half-open probe", () => {
	const manager = new CascadeStateManager({ initialBackoffMs: 100, maxBackoffMs: 1_000 });
	manager.createCascade("provider", "credential-a", "provider_transient", "temporary", 1_000);

	assert.equal(manager.tryReserveProbe("provider", 1_050), false);
	assert.equal(manager.tryReserveProbe("provider", 1_100), true);
	assert.equal(manager.tryReserveProbe("provider", 1_100), false);

	manager.releaseProbe("provider");
	assert.equal(manager.tryReserveProbe("provider", 1_100), true);
});

test("CascadeStateManager releases half-open probe on success and failure", () => {
	const manager = new CascadeStateManager({ initialBackoffMs: 100, maxBackoffMs: 1_000 });
	manager.createCascade("provider", "credential-a", "provider_transient", "temporary", 1_000);
	assert.equal(manager.tryReserveProbe("provider", 1_100), true);

	manager.recordCascadeAttempt("provider", "credential-a", "provider_transient", "still failing", 1_100);
	assert.equal(manager.tryReserveProbe("provider", 1_150), false);
	assert.equal(manager.tryReserveProbe("provider", 1_300), true);

	manager.clearCascade("provider");
	assert.equal(manager.tryReserveProbe("provider", 1_300), false);
});

test("CascadeStateManager removeCredential keeps cascade active for remaining credential", () => {
	// Use small backoff so nextRetryAt is reached quickly
	const manager = new CascadeStateManager({ initialBackoffMs: 10, maxBackoffMs: 100 });

	// Create cascade with 2 credentials
	manager.createCascade("provider", "credential-a", "provider_transient", "temporary", 1_000);
	manager.recordCascadeAttempt("provider", "credential-b", "provider_transient", "still failing", 1_050);

	let state = manager.getCascadeState("provider");
	assert.notEqual(state, null);
	assert.equal(state!.cascadePath.length, 2);
	assert.equal(state!.attemptCount, 2);

	// Remove credential-a only — cascade should stay active with credential-b
	manager.removeCredential("provider", "credential-a");

	state = manager.getCascadeState("provider");
	assert.notEqual(state, null, "Cascade must remain when at least one credential survives");
	assert.equal(state!.cascadePath.length, 1);
	assert.equal(state!.cascadePath[0].credentialId, "credential-b");
	assert.equal(state!.attemptCount, 1);

	// Probe can be reserved after nextRetryAt elapses — cascade is still active
	assert.equal(manager.tryReserveProbe("provider", 1_200), true);
	manager.releaseProbe("provider");

	// Remove the last credential — cascade should clear
	manager.removeCredential("provider", "credential-b");
	assert.equal(manager.getCascadeState("provider"), null);
	assert.equal(manager.tryReserveProbe("provider", 1_200), false);
});

test("CascadeStateManager removeCredential clears active probe when cascade path is empty", () => {
	const manager = new CascadeStateManager({ initialBackoffMs: 100, maxBackoffMs: 1_000 });
	manager.createCascade("provider", "credential-a", "provider_transient", "temporary", 1_000);
	assert.equal(manager.tryReserveProbe("provider", 1_100), true);

	manager.removeCredential("provider", "credential-a");

	assert.equal(manager.getCascadeState("provider"), null);
	assert.equal(manager.tryReserveProbe("provider", 1_100), false);
});
