import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type OverlayOptions } from "@earendil-works/pi-tui";
import {
	RESPONSIVE_MODAL_DEFAULT_SCALE,
	resolveBodyRowBudget,
	resolveResponsiveOverlayOptions,
	resolveResponsiveOverlayRuntimeOptions,
	type ModalOverlayOptions,
} from "./formatters/responsive-modal.js";
import { renderZellijFrameWithRenderer } from "./formatters/zellij-frame.js";
import type { SupportedProviderId } from "./types.js";

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export type ProviderConfigurationMode = "api_key" | "oauth";

export interface ProviderConfigurationOption {
	provider: SupportedProviderId;
	name: string;
	isConfigured: boolean;
	isSelected: boolean;
	credentialCount: number;
}

interface ProviderConfigurationDialogOptions {
	mode: ProviderConfigurationMode;
	options: readonly ProviderConfigurationOption[];
	selectedProvider: SupportedProviderId;
}

type ProviderConfigurationPane = "configured" | "available";

type ProviderConfigurationResult = { provider: SupportedProviderId } | null;

const DIALOG_MIN_SPLIT_WIDTH = 72;
const DIALOG_BODY_ROWS = Math.ceil(18 * RESPONSIVE_MODAL_DEFAULT_SCALE);
const DIALOG_MIN_BODY_ROWS = 3;
const FRAME_BORDER_ROWS = 2;
const COLUMN_GAP = 4;
const SEARCH_FIELD_WIDTH = 24;

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function fit(value: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const normalized = value.replace(/[\r\n\t]/g, " ");
	const truncated = truncateToWidth(normalized, width, "…", true);
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function divider(width: number): string {
	return "─".repeat(Math.max(1, width));
}

function formatProviderName(option: ProviderConfigurationOption): string {
	const name = normalizeText(option.name) || option.provider;
	return name === option.provider ? option.provider : `${name} (${option.provider})`;
}

function formatCredentialCountBadge(count: number): string {
	return `[${count} cred${count === 1 ? "" : "s"}]`;
}

function matchesSearch(option: ProviderConfigurationOption, query: string): boolean {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return true;
	}
	return `${option.name} ${option.provider}`.toLowerCase().includes(normalizedQuery);
}

function isTextInput(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

export function resolveProviderConfigurationOverlayOptions(
	terminal?: { terminalColumns?: number | null; terminalRows?: number | null },
): ModalOverlayOptions {
	return resolveResponsiveOverlayOptions({
		...terminal,
		minimumWidth: 48,
		maximumWidth: Math.ceil(120 * RESPONSIVE_MODAL_DEFAULT_SCALE),
		minimumHeight: 14,
		widthRatio: 0.92,
		heightRatio: 0.88,
	});
}

export function resolveProviderConfigurationRuntimeOverlayOptions(): OverlayOptions {
	return resolveResponsiveOverlayRuntimeOptions({
		minimumWidth: 48,
		widthRatio: 0.92,
		heightRatio: 0.88,
	});
}

export function resolveProviderConfigurationContentRows(
	overlayOptions: Pick<ModalOverlayOptions, "maxHeight">,
): number {
	return Math.max(1, overlayOptions.maxHeight - FRAME_BORDER_ROWS);
}

function resolveSplitBodyRows(maxContentRows: number | null): number {
	return resolveBodyRowBudget({
		defaultRows: DIALOG_BODY_ROWS,
		terminalRows: maxContentRows,
		reservedRows: 8,
		minimumRows: DIALOG_MIN_BODY_ROWS,
		fitAvailableRows: true,
	});
}

function resolveStackedBodyRows(maxContentRows: number | null): number {
	const combinedBodyRows = resolveBodyRowBudget({
		defaultRows: DIALOG_BODY_ROWS * 2,
		terminalRows: maxContentRows,
		reservedRows: 10,
		minimumRows: DIALOG_MIN_BODY_ROWS * 2,
		fitAvailableRows: true,
	});
	return Math.max(0, Math.floor(combinedBodyRows / 2));
}

function getScrollableSlice<T>(items: readonly T[], selectedIndex: number, visibleRows: number): readonly T[] {
	if (visibleRows <= 0) {
		return [];
	}
	if (items.length <= visibleRows) {
		return items;
	}
	const clampedSelection = Math.max(0, Math.min(items.length - 1, selectedIndex));
	const halfWindow = Math.floor(visibleRows / 2);
	const maxStart = Math.max(0, items.length - visibleRows);
	const start = Math.max(0, Math.min(maxStart, clampedSelection - halfWindow));
	return items.slice(start, start + visibleRows);
}

class ProviderConfigurationDialog {
	private focusedPane: ProviderConfigurationPane = "configured";
	private selectedConfiguredIndex = 0;
	private selectedAvailableIndex = 0;
	private searchQuery = "";

	constructor(
		private readonly options: ProviderConfigurationDialogOptions,
		private readonly theme: ThemeLike,
		private readonly done: (result: ProviderConfigurationResult) => void,
		private readonly resolveMaxContentRows: () => number | null,
	) {
		this.initializeSelection();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		this.clampSelections();
		if (safeWidth < DIALOG_MIN_SPLIT_WIDTH) {
			return this.renderStacked(safeWidth);
		}
		return this.renderSplit(safeWidth);
	}

	invalidate(): void {
		// Fully state-driven renderer.
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.focusedPane = this.focusedPane === "configured" ? "available" : "configured";
			this.clampSelections();
			return;
		}

		if (matchesKey(data, "up")) {
			this.moveSelection(-1);
			return;
		}

		if (matchesKey(data, "down")) {
			this.moveSelection(1);
			return;
		}

		if (matchesKey(data, "pageUp")) {
			this.moveSelection(-5);
			return;
		}

		if (matchesKey(data, "pageDown")) {
			this.moveSelection(5);
			return;
		}

		if (matchesKey(data, "return")) {
			const selected = this.getSelectedOption();
			if (selected) {
				this.done({ provider: selected.provider });
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			this.searchQuery = this.searchQuery.slice(0, -1);
			this.selectedAvailableIndex = 0;
			this.clampSelections();
			return;
		}

		if (matchesKey(data, "ctrl+u")) {
			this.searchQuery = "";
			this.selectedAvailableIndex = 0;
			return;
		}

		if (isTextInput(data)) {
			this.searchQuery += data;
			this.focusedPane = "available";
			this.selectedAvailableIndex = 0;
			this.clampSelections();
		}
	}

	private renderSplit(width: number): string[] {
		const gap = " ".repeat(COLUMN_GAP);
		const columnWidth = Math.floor((width - COLUMN_GAP) / 2);
		const rightWidth = width - COLUMN_GAP - columnWidth;
		const bodyRows = resolveSplitBodyRows(this.resolveMaxContentRows());
		const lines = [
			this.renderTitle(width),
			divider(width),
			"",
			`${this.renderPaneHeader("configured", columnWidth)}${gap}${this.renderPaneHeader("available", rightWidth)}`,
			`${fit(divider(columnWidth), columnWidth)}${gap}${fit(divider(rightWidth), rightWidth)}`,
		];
		const configuredRows = this.buildConfiguredRows(columnWidth, bodyRows);
		const availableRows = this.buildAvailableRows(rightWidth, bodyRows);
		for (let index = 0; index < bodyRows; index += 1) {
			lines.push(`${configuredRows[index] ?? fit("", columnWidth)}${gap}${availableRows[index] ?? fit("", rightWidth)}`);
		}
		lines.push("", divider(width), this.renderFooter(width));
		return lines;
	}

	private renderStacked(width: number): string[] {
		const bodyRows = resolveStackedBodyRows(this.resolveMaxContentRows());
		return [
			this.renderTitle(width),
			divider(width),
			this.renderPaneHeader("configured", width),
			divider(width),
			...this.buildConfiguredRows(width, bodyRows),
			"",
			this.renderPaneHeader("available", width),
			divider(width),
			...this.buildAvailableRows(width, bodyRows),
			"",
			divider(width),
			this.renderFooter(width),
		];
	}

	private renderTitle(width: number): string {
		const title = this.theme.fg("accent", this.theme.bold(`[ ${this.getTitle()} ]`));
		const search = `[ Search: ${this.searchQuery}_ ]`;
		const searchWidth = Math.min(SEARCH_FIELD_WIDTH, Math.max(12, width - visibleWidth(title) - 2));
		const fittedSearch = fit(search, searchWidth);
		const spacer = " ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(fittedSearch)));
		return fit(`${title}${spacer}${this.theme.fg("dim", fittedSearch)}`, width);
	}

	private renderPaneHeader(pane: ProviderConfigurationPane, width: number): string {
		const configuredCount = this.getConfiguredOptions().length;
		const availableCount = this.getAvailableOptions().length;
		const label = pane === "configured"
			? `${this.getConfiguredTitle()} (${configuredCount})`
			: this.searchQuery.trim()
				? `${this.getAvailableTitle()} (Filtered: ${availableCount})`
				: this.getAvailableTitle();
		const rendered = this.focusedPane === pane
			? this.theme.fg("accent", this.theme.bold(label))
			: this.theme.fg("dim", label);
		return fit(rendered, width);
	}

	private buildConfiguredRows(width: number, visibleRows: number): string[] {
		if (visibleRows <= 0) {
			return [];
		}
		const options = this.getConfiguredOptions();
		if (options.length === 0) {
			return [fit("  No configured credentials yet.", width)];
		}
		const visibleOptions = getScrollableSlice(options, this.selectedConfiguredIndex, visibleRows);
		const firstVisibleIndex = options.indexOf(visibleOptions[0] ?? options[0]);
		const rows = visibleOptions.map((option, offset) => {
			const optionIndex = firstVisibleIndex + offset;
			const selected = this.focusedPane === "configured" && optionIndex === this.selectedConfiguredIndex;
			const cursor = selected ? ">" : " ";
			return fit(`${cursor} [✓] ${formatProviderName(option)} ${formatCredentialCountBadge(option.credentialCount)}`, width);
		});
		if (options.length > visibleOptions.length && rows.length > 0) {
			rows[rows.length - 1] = fit("  … (PgDn for more)", width);
		}
		return rows;
	}

	private buildAvailableRows(width: number, visibleRows: number): string[] {
		if (visibleRows <= 0) {
			return [];
		}
		const options = this.getAvailableOptions();
		if (options.length === 0) {
			const message = this.searchQuery.trim()
				? "  No available providers match search."
				: "  No more providers available.";
			return [fit(message, width)];
		}
		const visibleOptions = getScrollableSlice(options, this.selectedAvailableIndex, visibleRows);
		const firstVisibleIndex = options.indexOf(visibleOptions[0] ?? options[0]);
		const rows = visibleOptions.map((option, offset) => {
			const optionIndex = firstVisibleIndex + offset;
			const selected = this.focusedPane === "available" && optionIndex === this.selectedAvailableIndex;
			const cursor = selected ? ">" : " ";
			return fit(`${cursor} ${formatProviderName(option)}`, width);
		});
		if (options.length > visibleOptions.length && rows.length > 0) {
			rows[rows.length - 1] = fit("  … (PgDn for more)", width);
		}
		return rows;
	}

	private renderFooter(width: number): string {
		const action = this.options.mode === "oauth" ? "Select/Edit" : "Select/Add";
		return fit(`[↑/↓] Navigate  |  [Enter] ${action}  |  [Tab] Switch Pane  |  Type to Search  |  [Esc] Cancel`, width);
	}

	private getTitle(): string {
		return this.options.mode === "oauth"
			? "OAUTH PROVIDER CONFIGURATION"
			: "API KEY PROVIDER CONFIGURATION";
	}

	private getConfiguredTitle(): string {
		return this.options.mode === "oauth" ? "ACTIVE CONNECTIONS" : "CONFIGURED API KEYS";
	}

	private getAvailableTitle(): string {
		return "AVAILABLE PROVIDERS";
	}

	private getConfiguredOptions(): readonly ProviderConfigurationOption[] {
		return this.options.options.filter((option) => option.isConfigured);
	}

	private getAvailableOptions(): readonly ProviderConfigurationOption[] {
		return this.options.options.filter((option) => !option.isConfigured && matchesSearch(option, this.searchQuery));
	}

	private getSelectedOption(): ProviderConfigurationOption | null {
		const options = this.focusedPane === "configured"
			? this.getConfiguredOptions()
			: this.getAvailableOptions();
		const index = this.focusedPane === "configured"
			? this.selectedConfiguredIndex
			: this.selectedAvailableIndex;
		return options[index] ?? null;
	}

	private moveSelection(delta: number): void {
		const options = this.focusedPane === "configured"
			? this.getConfiguredOptions()
			: this.getAvailableOptions();
		if (options.length === 0) {
			return;
		}
		if (this.focusedPane === "configured") {
			this.selectedConfiguredIndex = this.wrapIndex(this.selectedConfiguredIndex + delta, options.length);
			return;
		}
		this.selectedAvailableIndex = this.wrapIndex(this.selectedAvailableIndex + delta, options.length);
	}

	private wrapIndex(index: number, length: number): number {
		return ((index % length) + length) % length;
	}

	private initializeSelection(): void {
		const configuredIndex = this.getConfiguredOptions().findIndex((option) => option.isSelected);
		const availableIndex = this.getAvailableOptions().findIndex((option) => option.isSelected);
		if (configuredIndex >= 0) {
			this.selectedConfiguredIndex = configuredIndex;
			this.focusedPane = "configured";
			return;
		}
		if (availableIndex >= 0) {
			this.selectedAvailableIndex = availableIndex;
			this.focusedPane = "available";
			return;
		}
		if (this.getConfiguredOptions().length === 0) {
			this.focusedPane = "available";
		}
	}

	private clampSelections(): void {
		const configuredCount = this.getConfiguredOptions().length;
		const availableCount = this.getAvailableOptions().length;
		this.selectedConfiguredIndex = configuredCount > 0
			? Math.max(0, Math.min(this.selectedConfiguredIndex, configuredCount - 1))
			: 0;
		this.selectedAvailableIndex = availableCount > 0
			? Math.max(0, Math.min(this.selectedAvailableIndex, availableCount - 1))
			: 0;
		if (this.focusedPane === "configured" && configuredCount === 0 && availableCount > 0) {
			this.focusedPane = "available";
		}
		if (this.focusedPane === "available" && availableCount === 0 && configuredCount > 0) {
			this.focusedPane = "configured";
		}
	}
}

export async function runProviderConfigurationDialog(
	ctx: ExtensionCommandContext,
	options: ProviderConfigurationDialogOptions,
): Promise<SupportedProviderId | null> {
	const overlayOptions = resolveProviderConfigurationRuntimeOverlayOptions();
	const resolveMaxContentRows = (): number => resolveProviderConfigurationContentRows(
		resolveProviderConfigurationOverlayOptions(),
	);
	const result = await ctx.ui.custom<ProviderConfigurationResult>(
		(tui, theme, _keybindings, done) => {
			const dialog = new ProviderConfigurationDialog(options, theme, done, resolveMaxContentRows);
			return {
				render(width: number): string[] {
					const framed = renderZellijFrameWithRenderer(width, theme, {
						titleLeft: "",
						focused: true,
					}, (contentWidth) => dialog.render(contentWidth));
					return framed.lines;
				},
				invalidate(): void {
					dialog.invalidate();
				},
				handleInput(data: string): void {
					dialog.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions,
		},
	);
	return result?.provider ?? null;
}
