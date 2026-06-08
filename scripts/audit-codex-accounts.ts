/**
 * Audits all openai-codex credentials in ~/.pi/agent/auth.json:
 * working | needs_reauth | likely_banned | disabled_ui
 *
 * Usage:
 *   npx tsx scripts/audit-codex-accounts.ts
 *   npx tsx scripts/audit-codex-accounts.ts --reenable-misclassified
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	isAccountBannedOrRevokedError,
	isReauthOnlyError,
	isRotationSummaryError,
	shouldPermanentlyDisableCredential,
} from "../src/credential-disable-policy.ts";
import { extractCodexCredentialIdentity } from "../src/openai-codex-identity.ts";
import { refreshOAuthCredential } from "../src/oauth-compat.ts";
import { normalizeCodexPlanType, isPlanEligibleForModel } from "../src/model-entitlements.ts";
import { codexUsageProvider } from "../src/usage/codex.ts";
import { MultiAuthStorage } from "../src/storage.ts";

type Verdict = "working" | "needs_reauth" | "likely_banned" | "disabled_ui_only";

const reenableFlag = process.argv.includes("--reenable-misclassified");

async function clearMisclassifiedDisabled(openaiOnly = true): Promise<string[]> {
	const storage = new MultiAuthStorage();
	const cleared: string[] = [];
	await storage.withLock((state) => {
		for (const [provider, providerState] of Object.entries(state.providers ?? {})) {
			if (openaiOnly && provider !== "openai-codex") {
				continue;
			}
			const disabled = providerState.disabledCredentials ?? {};
			for (const [credentialId, entry] of Object.entries(disabled)) {
				const msg = entry?.error?.trim() ?? "";
				if (!msg) {
					delete disabled[credentialId];
					cleared.push(`${provider}/${credentialId}:empty`);
					continue;
				}
				if (
					isRotationSummaryError(msg) ||
					isReauthOnlyError(msg) ||
					!shouldPermanentlyDisableCredential(msg, "authentication")
				) {
					delete disabled[credentialId];
					cleared.push(`${provider}/${credentialId}`);
				}
			}
			if (Object.keys(disabled).length === 0) {
				providerState.disabledCredentials = {};
			}
		}
		return { result: cleared, next: state };
	});
	return cleared;
}

async function main(): Promise<void> {
	if (reenableFlag) {
		const cleared = await clearMisclassifiedDisabled(true);
		console.log(`Cleared ${cleared.length} misclassified disabled credential(s):`);
		for (const line of cleared) {
			console.log(`  - ${line}`);
		}
		console.log("");
	}

	const authPath = join(homedir(), ".pi/agent/auth.json");
	const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
	const storage = new MultiAuthStorage();
	const codexState = await storage.readProviderState("openai-codex");
	const disabledMap = codexState.disabledCredentials ?? {};

	const rows: Array<{
		credentialId: string;
		email: string | null;
		plan: string | null;
		verdict: Verdict;
		detail: string;
		disabledInUi: boolean;
	}> = [];

	for (const [key, value] of Object.entries(auth)) {
		if (!key.startsWith("openai-codex") || typeof value !== "object" || !value) {
			continue;
		}
		const cred = value as Record<string, unknown>;
		if (cred.type !== "oauth" || typeof cred.access !== "string" || typeof cred.refresh !== "string") {
			continue;
		}

		const identity = extractCodexCredentialIdentity({
			access: cred.access,
			accountId: cred.accountId,
			idToken: cred.idToken ?? cred.id_token,
		});
		const disabledEntry = disabledMap[key];
		const disabledInUi = Boolean(disabledEntry?.error);
		const disabledMsg = disabledEntry?.error?.trim() ?? "";

		let access = cred.access;
		let accountId =
			typeof cred.accountId === "string" ? cred.accountId : identity.accountId ?? undefined;
		let expires = typeof cred.expires === "number" ? cred.expires : 0;
		let refreshNote = "";
		let usageNote = "";
		let verdict: Verdict = "needs_reauth";
		let detail = "";

		try {
			const refreshed = await refreshOAuthCredential("openai-codex", {
				type: "oauth",
				access: cred.access,
				refresh: cred.refresh,
				expires,
				accountId,
				...(cred.idToken || cred.id_token
					? { idToken: (cred.idToken ?? cred.id_token) as string }
					: {}),
			} as Parameters<typeof refreshOAuthCredential>[1]);
			access = refreshed.access;
			accountId =
				typeof refreshed.accountId === "string" ? refreshed.accountId : accountId;
			expires = refreshed.expires;
			refreshNote = "refresh_ok";
		} catch (e: unknown) {
			refreshNote = String((e as Error)?.message ?? e);
		}

		try {
			const snap = await codexUsageProvider.fetchUsage({
				accessToken: access,
				accountId,
				credential: {
					type: "oauth",
					access,
					refresh: cred.refresh as string,
					expires,
					accountId,
				},
			});
			if (snap) {
				usageNote = `usage_ok:${snap.planType ?? "?"}`;
				verdict = disabledInUi && !isAccountBannedOrRevokedError(disabledMsg)
					? "disabled_ui_only"
					: "working";
				detail = `${refreshNote}; ${usageNote}`;
			} else {
				usageNote = "usage_null";
				detail = `${refreshNote}; ${usageNote}`;
			}
		} catch (e: unknown) {
			usageNote = String((e as Error)?.message ?? e);
			detail = `${refreshNote}; ${usageNote}`;
			const combined = `${refreshNote} ${usageNote}`.toLowerCase();
			if (
				combined.includes("denied") &&
				combined.includes("403") &&
				!combined.includes("expired")
			) {
				verdict = "likely_banned";
			} else if (isAccountBannedOrRevokedError(refreshNote) || isAccountBannedOrRevokedError(usageNote)) {
				verdict = "likely_banned";
			} else if (isReauthOnlyError(refreshNote) || isReauthOnlyError(usageNote) || combined.includes("expired")) {
				verdict = "needs_reauth";
			} else if (disabledInUi && isRotationSummaryError(disabledMsg)) {
				verdict = "disabled_ui_only";
			}
		}

		if (verdict === "needs_reauth" && disabledInUi && isRotationSummaryError(disabledMsg)) {
			verdict = "disabled_ui_only";
		}

		const planNorm = normalizeCodexPlanType(identity.planType);
		rows.push({
			credentialId: key,
			email: identity.email,
			plan: identity.planType,
			verdict,
			detail: detail.slice(0, 220),
			disabledInUi,
		});
	}

	rows.sort((a, b) => (a.email ?? a.credentialId).localeCompare(b.email ?? b.credentialId));

	const byVerdict = {
		working: rows.filter((r) => r.verdict === "working"),
		needs_reauth: rows.filter((r) => r.verdict === "needs_reauth"),
		likely_banned: rows.filter((r) => r.verdict === "likely_banned"),
		disabled_ui_only: rows.filter((r) => r.verdict === "disabled_ui_only"),
	};

	console.log(`Codex credential audit (${rows.length} rows) @ ${new Date().toISOString()}\n`);
	for (const [label, group] of Object.entries(byVerdict)) {
		console.log(`## ${label} (${group.length})`);
		for (const r of group) {
			const paid = isPlanEligibleForModel(normalizeCodexPlanType(r.plan));
			console.log(
				`  ${r.credentialId}\t${r.email ?? "?"}\tplan=${r.plan ?? "?"}${paid ? " (paid)" : ""}\tui_disabled=${r.disabledInUi}\t${r.detail}`,
			);
		}
		console.log("");
	}

	console.log(JSON.stringify({ summary: Object.fromEntries(Object.entries(byVerdict).map(([k, v]) => [k, v.length])), rows }, null, 2));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});