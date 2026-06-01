import assert from "node:assert/strict";
import test from "node:test";
import {
	CODEX_PROCESS_CREDENTIAL_LEASE_TTL_MS,
	pruneProviderCredentialLeases,
	getOwnedCredentialLease,
	getCredentialIdsLeasedByOtherOwners,
	buildCredentialLease,
} from "../src/account-manager.js";
import { parseCredentialLeases } from "../src/storage.js";
import type { ProviderCredentialLeaseState, ProviderRotationState } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMinimalState(
	credentialIds: string[],
	leases?: Record<string, ProviderCredentialLeaseState>,
): ProviderRotationState {
	return {
		credentialIds,
		activeIndex: 0,
		rotationMode: "usage-based",
		manualActiveCredentialId: undefined,
		lastUsedAt: {},
		usageCount: {},
		quotaErrorCount: {},
		quotaExhaustedUntil: {},
		lastQuotaError: {},
		lastTransientError: {},
		transientErrorCount: {},
		weeklyQuotaAttempts: {},
		friendlyNames: {},
		disabledCredentials: {},
		credentialLeases: leases,
	};
}

// ---------------------------------------------------------------------------
// buildCredentialLease
// ---------------------------------------------------------------------------

test("buildCredentialLease sets expiresAt using CODEX_PROCESS_CREDENTIAL_LEASE_TTL_MS", () => {
	const now = 1_000_000;
	const lease = buildCredentialLease("owner1", "cred1", now);
	assert.equal(lease.ownerId, "owner1");
	assert.equal(lease.credentialId, "cred1");
	assert.equal(lease.acquiredAt, now);
	assert.equal(lease.lastSeenAt, now);
	assert.equal(lease.expiresAt, now + CODEX_PROCESS_CREDENTIAL_LEASE_TTL_MS);
});

// ---------------------------------------------------------------------------
// pruneProviderCredentialLeases
// ---------------------------------------------------------------------------

test("pruneProviderCredentialLeases removes expired leases", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1", "cred2"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now - 100_000,
				lastSeenAt: now - 100_000,
				expiresAt: now - 1, // expired
			},
		},
	);
	const didChange = pruneProviderCredentialLeases(state, now);
	assert.equal(didChange, true);
	assert.equal(state.credentialLeases, undefined);
});

test("pruneProviderCredentialLeases preserves valid leases", () => {
	const now = 5_000_000;
	const validLease: ProviderCredentialLeaseState = {
		ownerId: "owner1",
		credentialId: "cred1",
		acquiredAt: now - 100_000,
		lastSeenAt: now - 10_000,
		expiresAt: now + 300_000,
	};
	const state = createMinimalState(["cred1", "cred2"], { owner1: validLease });
	const didChange = pruneProviderCredentialLeases(state, now);
	assert.equal(didChange, false);
	assert.deepEqual(state.credentialLeases?.owner1, validLease);
});

test("pruneProviderCredentialLeases removes leases for orphaned credentialIds", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred2", // not in credentialIds
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	pruneProviderCredentialLeases(state, now);
	assert.equal(state.credentialLeases, undefined);
});

test("pruneProviderCredentialLeases normalizes ownerId whitespace", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			"  owner1  ": {
				ownerId: "  owner1  ",
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	pruneProviderCredentialLeases(state, now);
	assert.ok(state.credentialLeases !== undefined);
	assert.equal(state.credentialLeases["  owner1  "], undefined);
	assert.equal(state.credentialLeases["owner1"]?.ownerId, "owner1");
});

test("pruneProviderCredentialLeases normalizes credentialId only when ownerId also normalizes", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			"  owner1  ": {
				ownerId: "  owner1  ",
				credentialId: "  cred1  ", // has whitespace
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	// Note: credentialId normalization is a side-effect of ownerId normalization
	// (the function only rewrites entries when ownerId changes)
	pruneProviderCredentialLeases(state, now);
	assert.ok(state.credentialLeases !== undefined);
	assert.equal(state.credentialLeases["owner1"]?.credentialId, "cred1");
});

test("pruneProviderCredentialLeases normalizes credentialId when ownerId stays unchanged", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "  cred1  ",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	pruneProviderCredentialLeases(state, now);
	assert.ok(state.credentialLeases !== undefined);
	assert.equal(state.credentialLeases.owner1?.credentialId, "cred1");
});

test("pruneProviderCredentialLeases falls back empty ownerId to entry key", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "", // empty ownerId — falls back to key
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	pruneProviderCredentialLeases(state, now);
	assert.ok(state.credentialLeases !== undefined);
	assert.equal(state.credentialLeases.owner1?.credentialId, "cred1");
});

test("pruneProviderCredentialLeases removes leases with missing credentialId", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	pruneProviderCredentialLeases(state, now);
	assert.equal(state.credentialLeases, undefined);
});

test("pruneProviderCredentialLeases removes leases with non-finite expiresAt", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: NaN,
			},
		},
	);
	pruneProviderCredentialLeases(state, now);
	assert.equal(state.credentialLeases, undefined);
});

test("pruneProviderCredentialLeases sets credentialLeases to undefined when empty", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now - 1,
			},
		},
	);
	pruneProviderCredentialLeases(state, now);
	assert.equal(state.credentialLeases, undefined);
});

test("pruneProviderCredentialLeases removes ownerIdToRemove leases", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1", "cred2"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
			owner2: {
				ownerId: "owner2",
				credentialId: "cred2",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	pruneProviderCredentialLeases(state, now, "owner1");
	assert.equal(state.credentialLeases?.owner1, undefined);
	assert.ok(state.credentialLeases?.owner2 !== undefined);
});

test("pruneProviderCredentialLeases returns false when no leases exist", () => {
	const now = 5_000_000;
	const state = createMinimalState(["cred1"]);
	const didChange = pruneProviderCredentialLeases(state, now);
	assert.equal(didChange, false);
});

// ---------------------------------------------------------------------------
// getOwnedCredentialLease
// ---------------------------------------------------------------------------

test("getOwnedCredentialLease returns the lease when valid", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	const lease = getOwnedCredentialLease(state, "owner1", now);
	assert.ok(lease !== undefined);
	assert.equal(lease?.credentialId, "cred1");
});

test("getOwnedCredentialLease returns undefined for expired lease", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now - 100_000,
				lastSeenAt: now - 100_000,
				expiresAt: now - 1,
			},
		},
	);
	const lease = getOwnedCredentialLease(state, "owner1", now);
	assert.equal(lease, undefined);
});

test("getOwnedCredentialLease returns undefined when credentialId no longer in state.credentialIds", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred2"], // only cred2, not cred1
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1", // not in credentialIds
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	const lease = getOwnedCredentialLease(state, "owner1", now);
	assert.equal(lease, undefined);
});

test("getOwnedCredentialLease returns undefined for non-existent owner", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	const lease = getOwnedCredentialLease(state, "nonexistent", now);
	assert.equal(lease, undefined);
});

test("getOwnedCredentialLease returns undefined when credentialLeases is undefined", () => {
	const now = 5_000_000;
	const state = createMinimalState(["cred1"]);
	const lease = getOwnedCredentialLease(state, "owner1", now);
	assert.equal(lease, undefined);
});

// ---------------------------------------------------------------------------
// getCredentialIdsLeasedByOtherOwners
// ---------------------------------------------------------------------------

test("getCredentialIdsLeasedByOtherOwners excludes own ownerId", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1", "cred2"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
			owner2: {
				ownerId: "owner2",
				credentialId: "cred2",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	const leased = getCredentialIdsLeasedByOtherOwners(state, "owner1", now);
	assert.deepEqual([...leased], ["cred2"]);
});

test("getCredentialIdsLeasedByOtherOwners includes other owners' valid leases", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1", "cred2"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
			owner2: {
				ownerId: "owner2",
				credentialId: "cred2",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	const leased = getCredentialIdsLeasedByOtherOwners(state, "owner2", now);
	assert.deepEqual([...leased], ["cred1"]);
});

test("getCredentialIdsLeasedByOtherOwners excludes expired other-owner leases", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1", "cred2"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred1",
				acquiredAt: now - 100_000,
				lastSeenAt: now - 100_000,
				expiresAt: now - 1,
			},
			owner2: {
				ownerId: "owner2",
				credentialId: "cred2",
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	const leased = getCredentialIdsLeasedByOtherOwners(state, "owner1", now);
	// owner1's own lease is expired and excluded anyway, owner2's is valid
	assert.deepEqual([...leased], ["cred2"]);
});

test("getCredentialIdsLeasedByOtherOwners returns empty when no credentialLeases", () => {
	const now = 5_000_000;
	const state = createMinimalState(["cred1"]);
	const leased = getCredentialIdsLeasedByOtherOwners(state, "owner1", now);
	assert.equal(leased.size, 0);
});

test("getCredentialIdsLeasedByOtherOwners excludes orphaned credentialIds from other owners", () => {
	const now = 5_000_000;
	const state = createMinimalState(
		["cred1"],
		{
			owner1: {
				ownerId: "owner1",
				credentialId: "cred2", // not in credentialIds
				acquiredAt: now,
				lastSeenAt: now,
				expiresAt: now + 300_000,
			},
		},
	);
	const leased = getCredentialIdsLeasedByOtherOwners(state, "owner2", now);
	assert.equal(leased.size, 0);
});

// ---------------------------------------------------------------------------
// parseCredentialLeases (storage.ts)
// ---------------------------------------------------------------------------

test("parseCredentialLeases returns undefined for non-object", () => {
	assert.equal(parseCredentialLeases(null), undefined);
	assert.equal(parseCredentialLeases(undefined), undefined);
	assert.equal(parseCredentialLeases("string"), undefined);
	assert.equal(parseCredentialLeases(42), undefined);
	assert.equal(parseCredentialLeases([]), undefined);
});

test("parseCredentialLeases returns undefined for empty object", () => {
	assert.equal(parseCredentialLeases({}), undefined);
});

test("parseCredentialLeases parses valid lease entries", () => {
	const now = 5_000_000;
	const result = parseCredentialLeases({
		owner1: {
			ownerId: "owner1",
			credentialId: "cred1",
			acquiredAt: now,
			lastSeenAt: now,
			expiresAt: now + 300_000,
		},
		owner2: {
			ownerId: "owner2",
			credentialId: "cred2",
			acquiredAt: now,
			lastSeenAt: now,
			expiresAt: now + 360_000,
		},
	});
	assert.ok(result !== undefined);
	assert.equal(result.owner1.credentialId, "cred1");
	assert.equal(result.owner1.expiresAt, now + 300_000);
	assert.equal(result.owner2.credentialId, "cred2");
	assert.equal(result.owner2.expiresAt, now + 360_000);
});

test("parseCredentialLeases normalizes ownerId whitespace", () => {
	const result = parseCredentialLeases({
		"  owner1  ": {
			ownerId: "  owner1  ",
			credentialId: "cred1",
			acquiredAt: 1000,
			lastSeenAt: 1000,
			expiresAt: 2000,
		},
	});
	assert.ok(result !== undefined);
	assert.equal(result["  owner1  "], undefined);
	assert.equal(result.owner1?.ownerId, "owner1");
});

test("parseCredentialLeases filters entries with missing credentialId", () => {
	const result = parseCredentialLeases({
		owner1: {
			ownerId: "owner1",
			credentialId: "",
			acquiredAt: 1000,
			lastSeenAt: 1000,
			expiresAt: 2000,
		},
	});
	assert.equal(result, undefined);
});

test("parseCredentialLeases filters entries with expiresAt <= 0", () => {
	const result = parseCredentialLeases({
		owner1: {
			ownerId: "owner1",
			credentialId: "cred1",
			acquiredAt: 1000,
			lastSeenAt: 1000,
			expiresAt: 0,
		},
	});
	assert.equal(result, undefined);
});

test("parseCredentialLeases filters non-record entries", () => {
	const result = parseCredentialLeases({
		owner1: "not-an-object",
	});
	assert.equal(result, undefined);
});

test("parseCredentialLeases uses ownerId from entry when present", () => {
	const result = parseCredentialLeases({
		owner1: {
			credentialId: "cred1",
			acquiredAt: 1000,
			lastSeenAt: 1000,
			expiresAt: 2000,
		},
	});
	assert.ok(result !== undefined);
	assert.equal(result.owner1.ownerId, "owner1"); // falls back to key
});

test("parseCredentialLeases replaces invalid acquiredAt with current time", () => {
	const before = Date.now();
	const result = parseCredentialLeases({
		owner1: {
			ownerId: "owner1",
			credentialId: "cred1",
			acquiredAt: "2024-01-01" as unknown as number,
			lastSeenAt: 1000,
			expiresAt: 5000,
		},
	});
	const after = Date.now();
	assert.ok(result !== undefined);
	assert.ok(result.owner1.acquiredAt >= before && result.owner1.acquiredAt <= after);
});
