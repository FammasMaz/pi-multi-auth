import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderWrappedFooterActions,
	RESPONSIVE_MODAL_DEFAULT_SCALE,
	resolveBodyRowBudget,
	resolveResponsiveOverlayOptions,
	resolveTerminalRows,
	wrapTextToWidth,
} from "../src/formatters/responsive-modal.js";
import { renderZellijFrame } from "../src/formatters/zellij-frame.js";
import {
	formatProviderBadge,
	truncateAccountIdentifier,
} from "../src/formatters/multi-auth-display.js";
import {
	formatHiddenProviderHint,
	resolveFooterActions,
	summarizeProviderVisibility,
} from "../src/formatters/modal-ui.js";
import { formatRotationModeLabel } from "../src/rotation-modes.js";
import {
	hydrateStatusWithCachedUsage,
	renderAccountEntryLines,
	resolveModalRefreshAction,
	resolveMultiAuthContentRows,
	resolveMultiAuthOverlayOptions,
	splitPaneWidths,
} from "../src/commands.js";
import { resolveOAuthLoginOverlayOptions } from "../src/oauth-login-flow.js";
import { resolveProviderConfigurationOverlayOptions } from "../src/provider-configuration-dialog.js";
import type { CredentialStatus, ProviderStatus, SupportedProviderId } from "../src/types.js";

const PROVIDER_FOOTER_ACTIONS = resolveFooterActions({
	focusedPane: "providers",
	renameMode: false,
	hasProviderSelection: true,
	hasProviderCredentials: true,
	selectedEntryKind: "account",
	selectedProviderPaneEntryKind: "provider",
	selectedProviderHidden: false,
	hasHiddenProviders: true,
	showHiddenProviders: false,
	hasDisabledAccounts: true,
	showDisabledAccounts: false,
	hasBatchSelection: false,
	selectedAccountMarked: false,
});

test("wrapped footer actions keep provider keybinds visible on narrow widths", () => {
	const lines = renderWrappedFooterActions(PROVIDER_FOOTER_ACTIONS, 20);
	const rendered = lines.join("\n");

	assert.ok(lines.length > 2, "expected multiline footer rendering for width=20");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 20, `line exceeded width budget: ${line}`);
	}

	for (const keybind of ["[Enter]", "[m]", "[v]", "[Esc]"]) {
		assert.match(rendered, new RegExp(keybind.replace(/[\[\]]/g, "\\$&")));
	}
	assert.doesNotMatch(rendered, /\[r\]/, "provider footer should not include rename");
});

test("account footer actions only show account-scoped actions", () => {
	const actions = resolveFooterActions({
		focusedPane: "accounts",
		renameMode: false,
		hasProviderSelection: true,
		hasProviderCredentials: true,
		selectedEntryKind: "account",
		selectedProviderHidden: false,
		hasHiddenProviders: true,
		showHiddenProviders: false,
		hasDisabledAccounts: false,
		showDisabledAccounts: false,
		hasBatchSelection: false,
		selectedAccountMarked: false,
	});

	assert.deepEqual(actions, [
		"[Enter] Set/Clear Manual Active",
		"[Space] Mark",
		"[r] Rename",
		"[T] Refresh Selected",
		"[d] Delete",
		"[v] Show Hidden/Empty",
		"[←/→] Pane",
		"[Esc] Close",
	]);
});

test("account add row footer avoids duplicate add shortcut", () => {
	const actions = resolveFooterActions({
		focusedPane: "accounts",
		renameMode: false,
		hasProviderSelection: true,
		hasProviderCredentials: true,
		selectedEntryKind: "add",
		selectedProviderHidden: false,
		hasHiddenProviders: false,
		showHiddenProviders: false,
		hasDisabledAccounts: false,
		showDisabledAccounts: false,
		hasBatchSelection: false,
		selectedAccountMarked: false,
	});

	assert.deepEqual(actions, ["[Enter] Add", "[←/→] Pane", "[Esc] Close"]);
});

test("modal refresh key resolution keeps account-pane refresh targeted", () => {
	assert.equal(resolveModalRefreshAction("T", "accounts", "account"), "selected-account");
	assert.equal(resolveModalRefreshAction("t", "accounts", "account"), "selected-account");
	assert.equal(resolveModalRefreshAction("t", "providers", "account"), "provider");
	assert.equal(resolveModalRefreshAction("T", "accounts", "add"), "none");
});

test("rename mode footer collapses to save and cancel", () => {
	const actions = resolveFooterActions({
		focusedPane: "accounts",
		renameMode: true,
		hasProviderSelection: true,
		hasProviderCredentials: true,
		selectedEntryKind: "account",
		selectedProviderHidden: false,
		hasHiddenProviders: true,
		showHiddenProviders: false,
		hasDisabledAccounts: true,
		showDisabledAccounts: false,
		hasBatchSelection: false,
		selectedAccountMarked: false,
	});

	assert.deepEqual(actions, ["[Enter] Save", "[Esc] Cancel Rename"]);
});

test("body row budget shrinks when terminal rows are constrained", () => {
	const bodyRows = resolveBodyRowBudget({
		defaultRows: 22,
		terminalRows: 14,
		reservedRows: 9,
		minimumRows: 4,
	});

	assert.equal(bodyRows, 5);
});

test("body row budget can prioritize fixed chrome when overlays are very short", () => {
	const bodyRows = resolveBodyRowBudget({
		defaultRows: 22,
		terminalRows: 10,
		reservedRows: 12,
		minimumRows: 4,
		fitAvailableRows: true,
	});

	assert.equal(bodyRows, 0);
});

test("responsive overlay fallback defaults are at least 40% larger", () => {
	const overlay = resolveResponsiveOverlayOptions({
		terminalColumns: Number.NaN,
		terminalRows: Number.NaN,
	});
	const previousDefaultWidth = Math.floor(120 * 0.92);
	const previousDefaultHeight = Math.floor(36 * 0.86);

	assert.ok(
		overlay.width >= Math.ceil(previousDefaultWidth * RESPONSIVE_MODAL_DEFAULT_SCALE),
		`expected fallback width to scale by ${RESPONSIVE_MODAL_DEFAULT_SCALE}x`,
	);
	assert.ok(
		overlay.maxHeight >= Math.ceil(previousDefaultHeight * RESPONSIVE_MODAL_DEFAULT_SCALE),
		`expected fallback height to scale by ${RESPONSIVE_MODAL_DEFAULT_SCALE}x`,
	);
});

test("modal-specific preferred dimensions are at least 40% larger when space allows", () => {
	const largeTerminal = { terminalColumns: 240, terminalRows: 80 };
	const cases = [
		{
			name: "multi-auth",
			resolveOverlay: resolveMultiAuthOverlayOptions,
			previousWidth: 132,
			previousHeight: Math.floor(36 * 0.9),
		},
		{
			name: "provider configuration",
			resolveOverlay: resolveProviderConfigurationOverlayOptions,
			previousWidth: 120,
			previousHeight: Math.floor(36 * 0.88),
		},
		{
			name: "oauth login",
			resolveOverlay: resolveOAuthLoginOverlayOptions,
			previousWidth: 110,
			previousHeight: Math.floor(36 * 0.86),
		},
	] as const;

	for (const testCase of cases) {
		const overlay = testCase.resolveOverlay(largeTerminal);
		const targetWidth = Math.ceil(testCase.previousWidth * RESPONSIVE_MODAL_DEFAULT_SCALE);
		const targetHeight = Math.ceil(testCase.previousHeight * RESPONSIVE_MODAL_DEFAULT_SCALE);

		assert.ok(overlay.width >= targetWidth, `${testCase.name} width did not scale by 40%`);
		assert.ok(overlay.maxHeight >= targetHeight, `${testCase.name} height did not scale by 40%`);
		assert.ok(overlay.width <= largeTerminal.terminalColumns - overlay.margin * 2);
		assert.ok(overlay.maxHeight <= largeTerminal.terminalRows - overlay.margin * 2);
	}
});

test("responsive overlay options are numeric and stay inside terminal margins", () => {
	const matrices = [
		{ terminalColumns: 52, terminalRows: 20 },
		{ terminalColumns: 80, terminalRows: 24 },
		{ terminalColumns: 120, terminalRows: 36 },
		{ terminalColumns: 180, terminalRows: 54 },
	] as const;
	const resolvers = [
		resolveResponsiveOverlayOptions,
		resolveMultiAuthOverlayOptions,
		resolveProviderConfigurationOverlayOptions,
		resolveOAuthLoginOverlayOptions,
	] as const;

	for (const terminal of matrices) {
		for (const resolveOverlay of resolvers) {
			const overlay = resolveOverlay(terminal);
			assert.equal(overlay.anchor, "center");
			assert.equal(typeof overlay.width, "number");
			assert.equal(typeof overlay.maxHeight, "number");
			assert.ok(Number.isInteger(overlay.width), "width should be an integer column count");
			assert.ok(Number.isInteger(overlay.maxHeight), "height should be an integer row count");
			assert.ok(overlay.width <= terminal.terminalColumns - overlay.margin * 2);
			assert.ok(overlay.maxHeight <= terminal.terminalRows - overlay.margin * 2);
			assert.ok(overlay.width >= 1);
			assert.ok(overlay.maxHeight >= 1);
		}
	}
});

test("rendered multi-auth modal budget keeps status and footer visible across terminal sizes", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const matrices = [
		{ terminalColumns: 52, terminalRows: 20, expectThreePane: false },
		{ terminalColumns: 80, terminalRows: 24, expectThreePane: false },
		{ terminalColumns: 120, terminalRows: 36, expectThreePane: true },
		{ terminalColumns: 180, terminalRows: 54, expectThreePane: true },
	] as const;

	for (const terminal of matrices) {
		const overlay = resolveMultiAuthOverlayOptions(terminal);
		const contentWidth = Math.max(1, overlay.width - 2);
		const statusLines = wrapTextToWidth("Status: Focused pane: Providers.", contentWidth);
		const footerLines = renderWrappedFooterActions(PROVIDER_FOOTER_ACTIONS, contentWidth);
		const dashboardChromeRows = contentWidth >= 96 ? 3 : 0;
		const reservedRows = statusLines.length + footerLines.length + dashboardChromeRows + 4;
		const bodyRows = resolveBodyRowBudget({
			defaultRows: 22,
			terminalRows: resolveMultiAuthContentRows(overlay),
			reservedRows,
			minimumRows: 4,
			fitAvailableRows: true,
		});
		const contentLines = [
			"  Pi Multi Auth",
			"",
			...Array.from({ length: dashboardChromeRows + bodyRows }, () => "dashboard"),
			"",
			...statusLines,
			"─".repeat(contentWidth),
			...footerLines,
		];
		const rendered = renderZellijFrame(contentLines, overlay.width, theme, {
			titleLeft: "",
			focused: true,
		});
		const output = rendered.lines.join("\n");

		assert.ok(rendered.lines.length <= overlay.maxHeight);
		assert.match(output, /Status: Focused pane: Providers\./);
		assert.match(output, /\[Esc\] Close/);
		assert.equal(contentWidth >= 96, terminal.expectThreePane);
		for (const line of rendered.lines) {
			assert.equal(visibleWidth(line), overlay.width);
		}
	}
});

test("three-pane accounts header fits at responsive modal width", () => {
	const widths = splitPaneWidths(110);
	const accountInnerWidth = Math.max(1, widths.accounts - 4);
	const headerText = "Accounts: github-copilot (1)";

	assert.ok(
		accountInnerWidth >= visibleWidth(headerText),
		`expected accounts inner width ${accountInnerWidth} to fit ${headerText}`,
	);
});

test("account rows use full pane width for unlabeled credential IDs", () => {
	const credential: CredentialStatus = {
		credentialId: "verylongusername@example.com",
		credentialType: "oauth",
		redactedSecret: "token",
		index: 0,
		isActive: true,
		isExpired: false,
		usageCount: 0,
		quotaErrorCount: 0,
		expiresAt: null,
	};
	const lines = renderAccountEntryLines({
		credential,
		contentWidth: 36,
		isSelected: true,
		isMarked: true,
		statusCell: "[●]",
	});

	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /verylongusername@example\.com/);
	assert.doesNotMatch(lines[0] ?? "", /…/);
	assert.equal(visibleWidth(lines[0] ?? ""), 36);
});

test("account rows stay width-bounded in genuinely narrow panes", () => {
	const credential: CredentialStatus = {
		credentialId: "verylongusername@example.com",
		credentialType: "oauth",
		redactedSecret: "token",
		index: 0,
		isActive: true,
		isExpired: false,
		usageCount: 0,
		quotaErrorCount: 0,
		expiresAt: null,
	};
	const lines = renderAccountEntryLines({
		credential,
		contentWidth: 16,
		isSelected: true,
		isMarked: true,
		statusCell: "[●]",
	});

	assert.ok(lines.length > 1, "expected narrow account rows to wrap");
	for (const line of lines) {
		assert.equal(visibleWidth(line), 16);
	}
});

test("terminal row resolver falls back to LINES env when stdout rows are unavailable", () => {
	const originalLines = process.env.LINES;
	process.env.LINES = "17";
	try {
		const rows = resolveTerminalRows();
		assert.equal(rows, 17);
	} finally {
		if (originalLines === undefined) {
			delete process.env.LINES;
		} else {
			process.env.LINES = originalLines;
		}
	}
});

test("zellij frame no longer forces large minimum width", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};

	const rendered = renderZellijFrame(["hello"], 8, theme, {
		titleLeft: "",
		minWidth: 42,
		focused: true,
	});

	assert.equal(rendered.contentWidth, 6);
	for (const line of rendered.lines) {
		assert.equal(visibleWidth(line), 8);
	}
});

test("zellij frame renders a top-left title without breaking width", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};

	const rendered = renderZellijFrame(["hello"], 20, theme, {
		titleLeft: "Pi Multi Auth",
		focused: true,
	});

	assert.match(rendered.lines[0] ?? "", /Pi Multi Auth/);
	for (const line of rendered.lines) {
		assert.equal(visibleWidth(line), 20);
	}
});

test("word wrapping handles extremely small widths", () => {
	const wrapped = wrapTextToWidth("[Enter] Set/Clear Manual Active", 3);
	assert.ok(wrapped.length > 3);
	for (const line of wrapped) {
		assert.ok(visibleWidth(line) <= 3);
	}
});

test("account identifiers keep email domains visible with middle ellipsis", () => {
	const shortened = truncateAccountIdentifier("verylongusername@example.com", 15);
	assert.equal(shortened, "ve…@example.com");
	assert.ok(visibleWidth(shortened) <= 15);

	const tiny = truncateAccountIdentifier("verylongusername@example.com", 5);
	assert.ok(visibleWidth(tiny) <= 5);
});

test("provider badge switches to cleaner compact variants by width", () => {
	const wide = formatProviderBadge({
		isHidden: false,
		isManual: false,
		visibleCount: 5,
		totalCount: 5,
		maxWidth: 32,
	});
	assert.equal(wide, "[5/5]");

	const manual = formatProviderBadge({
		isHidden: false,
		isManual: true,
		visibleCount: 5,
		totalCount: 5,
		maxWidth: 32,
	});
	assert.equal(manual, "[Manual • 5/5]");

	const hidden = formatProviderBadge({
		isHidden: true,
		isManual: false,
		visibleCount: 0,
		totalCount: 0,
		maxWidth: 10,
	});
	assert.equal(hidden, "[Hid 0/0]");

	const narrow = formatProviderBadge({
		isHidden: true,
		isManual: true,
		visibleCount: 5,
		totalCount: 5,
		maxWidth: 10,
	});
	assert.equal(narrow, "[H M 5/5]");

	const tiny = formatProviderBadge({
		isHidden: false,
		isManual: false,
		visibleCount: 5,
		totalCount: 5,
		maxWidth: 4,
	});
	assert.ok(visibleWidth(tiny) <= 4);
});

test("provider visibility hides zero-credential providers by default", () => {
	const statuses = [
		{
			provider: "openai-codex",
			rotationMode: "round-robin",
			activeIndex: 0,
			credentials: [
				{
					credentialId: "openai-codex",
					credentialType: "oauth",
					redactedSecret: "sk-***",
					index: 0,
					isActive: true,
					isExpired: false,
					usageCount: 0,
					quotaErrorCount: 0,
					expiresAt: null,
				},
			],
		},
		{
			provider: "anthropic",
			rotationMode: "round-robin",
			activeIndex: 0,
			credentials: [],
		},
	] as const;

	const hiddenSummary = summarizeProviderVisibility(statuses, new Set<string>(), false);
	assert.deepEqual(hiddenSummary.displayedStatuses.map((status) => status.provider), ["openai-codex"]);
	assert.equal(hiddenSummary.hiddenStatusCount, 1);
	assert.equal(formatHiddenProviderHint(hiddenSummary), "Press [v] to show 1 provider (empty).");

	const revealedSummary = summarizeProviderVisibility(statuses, new Set<string>(), true);
	assert.deepEqual(revealedSummary.displayedStatuses.map((status) => status.provider), [
		"openai-codex",
		"anthropic",
	]);
});

test("zellij frame strips embedded newlines from cell content", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};

	const rendered = renderZellijFrame(["[The\nus]"], 12, theme, {
		titleLeft: "",
		focused: true,
	});

	for (const line of rendered.lines) {
		assert.ok(!line.includes("\n"), `line should not contain newline: ${line}`);
		assert.equal(visibleWidth(line), 12);
	}
});

test("provider footer actions expose rotation mode control", () => {
	assert.deepEqual(PROVIDER_FOOTER_ACTIONS, [
		"[Enter] Focus Accounts",
		"[m] Rotation Mode",
		"[t] Refresh Provider",
		"[h] Hide Provider",
		"[v] Show Hidden/Empty",
		"[x] Show Disabled",
		"[←/→] Pane",
		"[Esc] Close",
	]);
});

test("provider add row footer surfaces enter-based add action", () => {
	const actions = resolveFooterActions({
		focusedPane: "providers",
		renameMode: false,
		hasProviderSelection: false,
		hasProviderCredentials: false,
		selectedEntryKind: "none",
		selectedProviderPaneEntryKind: "add",
		selectedProviderHidden: false,
		hasHiddenProviders: false,
		showHiddenProviders: false,
		hasDisabledAccounts: false,
		showDisabledAccounts: false,
		hasBatchSelection: false,
		selectedAccountMarked: false,
	});

	assert.deepEqual(actions, ["[Enter] Add Provider", "[←/→] Pane", "[Esc] Close"]);
});

test("modal status hydration uses display-only last-known usage snapshots", () => {
	const status: ProviderStatus = {
		provider: "openai-codex",
		rotationMode: "round-robin",
		activeIndex: 0,
		credentials: [
			{
				credentialId: "openai-codex",
				credentialType: "oauth",
				redactedSecret: "token",
				index: 0,
				isActive: true,
				isExpired: false,
				usageCount: 0,
				quotaErrorCount: 0,
				expiresAt: null,
			},
		],
	};
	const now = Date.now();
	const hydrated = hydrateStatusWithCachedUsage(
		{
			getCachedCredentialUsageDisplaySnapshot(provider: SupportedProviderId, credentialId: string) {
				assert.equal(provider, "openai-codex");
				assert.equal(credentialId, "openai-codex");
				return {
					snapshot: {
						timestamp: now,
						provider,
						planType: "ChatGPT Team",
						primary: null,
						secondary: null,
						credits: null,
						copilotQuota: null,
						updatedAt: now,
					},
					error: null,
					displayOnly: true,
				};
			},
		},
		status,
	);

	assert.equal(hydrated.credentials[0]?.usageSnapshot?.planType, "ChatGPT Team");
	assert.equal(hydrated.credentials[0]?.usageSnapshotDisplayOnly, true);
});

test("rotation mode labels reflect the actual configured mode", () => {
	assert.equal(formatRotationModeLabel("round-robin"), "Round-Robin Rotation");
	assert.equal(formatRotationModeLabel("usage-based"), "Usage-Based Rotation");
	assert.equal(formatRotationModeLabel("balancer"), "Balancer Rotation");
});
