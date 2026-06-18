import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyCredentialPlanTier,
	filterCredentialsByPlan,
	resolveCredentialPlanLabel,
} from "../src/commands.js";
import type { CredentialStatus } from "../src/types.js";

function makeCredential(overrides: Partial<CredentialStatus> = {}): CredentialStatus {
	return {
		credentialId: "cred-1",
		provider: "openai-codex",
		type: "oauth",
		alias: "test",
		...overrides,
	} as CredentialStatus;
}

test("resolveCredentialPlanLabel prefers usage snapshot plan", () => {
	const label = resolveCredentialPlanLabel(
		makeCredential({ usageSnapshot: { planType: "ChatGPT Plus" } as CredentialStatus["usageSnapshot"] }),
	);
	assert.equal(label, "ChatGPT Plus");
});

test("classifyCredentialPlanTier maps plus to paid", () => {
	assert.equal(
		classifyCredentialPlanTier(
			makeCredential({ usageSnapshot: { planType: "ChatGPT Plus" } as CredentialStatus["usageSnapshot"] }),
		),
		"paid",
	);
});

test("filterCredentialsByPlan keeps unknown-plan credentials visible", () => {
	const credentials = [
		makeCredential({ credentialId: "a", usageSnapshot: { planType: "ChatGPT Free" } as CredentialStatus["usageSnapshot"] }),
		makeCredential({ credentialId: "b", usageSnapshot: { planType: "ChatGPT Plus" } as CredentialStatus["usageSnapshot"] }),
		makeCredential({ credentialId: "c" }),
	];
	const paidOnly = filterCredentialsByPlan(credentials, "paid");
	assert.deepEqual(paidOnly.map((c) => c.credentialId), ["b", "c"]);
});