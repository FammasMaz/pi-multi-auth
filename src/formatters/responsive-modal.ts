import { visibleWidth, type OverlayOptions } from "@earendil-works/pi-tui";

const FOOTER_SEPARATOR = "  ";

export const RESPONSIVE_MODAL_DEFAULT_SCALE = 1.4;

const BASE_FALLBACK_COLUMNS = 120;
const BASE_FALLBACK_ROWS = 36;
const DEFAULT_FALLBACK_COLUMNS = Math.ceil(BASE_FALLBACK_COLUMNS * RESPONSIVE_MODAL_DEFAULT_SCALE);
const DEFAULT_FALLBACK_ROWS = Math.ceil(BASE_FALLBACK_ROWS * RESPONSIVE_MODAL_DEFAULT_SCALE);

interface BodyRowBudgetOptions {
	defaultRows: number;
	terminalRows: number | null;
	reservedRows: number;
	minimumRows?: number;
	fitAvailableRows?: boolean;
}

export interface ModalOverlayOptions {
	anchor: "center";
	width: number;
	maxHeight: number;
	margin: number;
}

interface ResponsiveOverlayOptions {
	terminalColumns?: number | null;
	terminalRows?: number | null;
	fallbackColumns?: number;
	fallbackRows?: number;
	margin?: number;
	minimumWidth?: number;
	maximumWidth?: number;
	minimumHeight?: number;
	maximumHeight?: number;
	widthRatio?: number;
	heightRatio?: number;
}

interface ResponsiveRuntimeOverlayOptions {
	margin?: number;
	minimumWidth?: number;
	widthRatio?: number;
	heightRatio?: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function toSafePositiveInteger(value: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.floor(value));
}

function toPercentSizeValue(ratio: number | undefined, fallback: number): `${number}%` {
	const safeRatio = Number.isFinite(ratio) ? ratio as number : fallback;
	const percent = clamp(safeRatio, 0.01, 1) * 100;
	return `${Number(percent.toFixed(2))}%` as `${number}%`;
}

export function resolveResponsiveOverlayRuntimeOptions(
	options: ResponsiveRuntimeOverlayOptions = {},
): OverlayOptions {
	return {
		anchor: "center",
		width: toPercentSizeValue(options.widthRatio, 0.92),
		maxHeight: toPercentSizeValue(options.heightRatio, 0.86),
		minWidth: Math.max(1, Math.floor(options.minimumWidth ?? 48)),
		margin: Math.max(0, Math.floor(options.margin ?? 1)),
	};
}

function splitLongToken(token: string, maxWidth: number): string[] {
	const safeWidth = Math.max(1, maxWidth);
	const parts: string[] = [];
	let current = "";
	let currentWidth = 0;

	for (const char of token) {
		const charWidth = Math.max(0, visibleWidth(char));
		if (current && currentWidth + charWidth > safeWidth) {
			parts.push(current);
			current = char;
			currentWidth = charWidth;
			continue;
		}
		current += char;
		currentWidth += charWidth;
	}

	if (current) {
		parts.push(current);
	}

	return parts.length > 0 ? parts : [""];
}

export function wrapTextToWidth(text: string, maxWidth: number): string[] {
	const safeWidth = Math.max(1, Math.floor(maxWidth));
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}

	const words = trimmed.split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}

	const lines: string[] = [];
	let currentLine = "";
	let currentWidth = 0;

	for (const word of words) {
		const wordWidth = Math.max(0, visibleWidth(word));
		if (wordWidth > safeWidth) {
			if (currentLine) {
				lines.push(currentLine);
				currentLine = "";
				currentWidth = 0;
			}
			lines.push(...splitLongToken(word, safeWidth));
			continue;
		}

		if (!currentLine) {
			currentLine = word;
			currentWidth = wordWidth;
			continue;
		}

		if (currentWidth + 1 + wordWidth <= safeWidth) {
			currentLine += ` ${word}`;
			currentWidth += 1 + wordWidth;
			continue;
		}

		lines.push(currentLine);
		currentLine = word;
		currentWidth = wordWidth;
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
}

export function renderWrappedFooterActions(actions: readonly string[], maxWidth: number): string[] {
	const safeWidth = Math.max(1, Math.floor(maxWidth));
	const normalizedActions = actions.map((action) => action.trim()).filter(Boolean);
	if (normalizedActions.length === 0) {
		return [];
	}

	const lines: string[] = [];
	let currentLine = "";
	let currentWidth = 0;
	const separatorWidth = visibleWidth(FOOTER_SEPARATOR);

	for (const action of normalizedActions) {
		const wrappedActionParts = wrapTextToWidth(action, safeWidth);
		for (const part of wrappedActionParts) {
			const partWidth = Math.max(0, visibleWidth(part));
			if (!currentLine) {
				currentLine = part;
				currentWidth = partWidth;
				continue;
			}

			if (currentWidth + separatorWidth + partWidth <= safeWidth) {
				currentLine += `${FOOTER_SEPARATOR}${part}`;
				currentWidth += separatorWidth + partWidth;
				continue;
			}

			lines.push(currentLine);
			currentLine = part;
			currentWidth = partWidth;
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
}

export function resolveTerminalRows(): number | null {
	if (typeof process.stdout.rows === "number" && Number.isFinite(process.stdout.rows)) {
		return toSafePositiveInteger(process.stdout.rows, 1);
	}

	const fromEnv = Number.parseInt(process.env.LINES ?? "", 10);
	if (Number.isFinite(fromEnv) && fromEnv > 0) {
		return toSafePositiveInteger(fromEnv, 1);
	}

	return null;
}

export function resolveTerminalColumns(): number | null {
	if (typeof process.stdout.columns === "number" && Number.isFinite(process.stdout.columns)) {
		return toSafePositiveInteger(process.stdout.columns, 1);
	}

	const fromEnv = Number.parseInt(process.env.COLUMNS ?? "", 10);
	if (Number.isFinite(fromEnv) && fromEnv > 0) {
		return toSafePositiveInteger(fromEnv, 1);
	}

	return null;
}

export function resolveResponsiveOverlayOptions(
	options: ResponsiveOverlayOptions = {},
): ModalOverlayOptions {
	const terminalColumns = toSafePositiveInteger(
		options.terminalColumns ?? resolveTerminalColumns() ?? options.fallbackColumns ?? DEFAULT_FALLBACK_COLUMNS,
		options.fallbackColumns ?? DEFAULT_FALLBACK_COLUMNS,
	);
	const terminalRows = toSafePositiveInteger(
		options.terminalRows ?? resolveTerminalRows() ?? options.fallbackRows ?? DEFAULT_FALLBACK_ROWS,
		options.fallbackRows ?? DEFAULT_FALLBACK_ROWS,
	);
	const requestedMargin = Math.max(0, Math.floor(options.margin ?? 1));
	const margin = terminalColumns > requestedMargin * 2 + 1 && terminalRows > requestedMargin * 2 + 1
		? requestedMargin
		: 0;
	const availableWidth = Math.max(1, terminalColumns - margin * 2);
	const availableHeight = Math.max(1, terminalRows - margin * 2);

	const minimumWidth = Math.min(
		availableWidth,
		Math.max(1, Math.floor(options.minimumWidth ?? 48)),
	);
	const maximumWidth = Math.min(
		availableWidth,
		Math.max(minimumWidth, Math.floor(options.maximumWidth ?? availableWidth)),
	);
	const preferredWidth = Math.floor(terminalColumns * (options.widthRatio ?? 0.92));
	const width = clamp(preferredWidth, minimumWidth, maximumWidth);

	const minimumHeight = Math.min(
		availableHeight,
		Math.max(1, Math.floor(options.minimumHeight ?? 12)),
	);
	const maximumHeight = Math.min(
		availableHeight,
		Math.max(minimumHeight, Math.floor(options.maximumHeight ?? availableHeight)),
	);
	const preferredHeight = Math.floor(terminalRows * (options.heightRatio ?? 0.86));
	const maxHeight = clamp(preferredHeight, minimumHeight, maximumHeight);

	return {
		anchor: "center",
		width,
		maxHeight,
		margin,
	};
}

export function resolveBodyRowBudget(options: BodyRowBudgetOptions): number {
	const defaultRows = Math.max(1, Math.floor(options.defaultRows));
	const minimumRows = clamp(Math.floor(options.minimumRows ?? 4), 1, defaultRows);

	if (typeof options.terminalRows !== "number" || !Number.isFinite(options.terminalRows)) {
		return defaultRows;
	}

	const terminalRows = toSafePositiveInteger(options.terminalRows, defaultRows);
	const reservedRows = Math.max(0, Math.floor(options.reservedRows));
	const availableRows = terminalRows - reservedRows;
	if (options.fitAvailableRows && availableRows < minimumRows) {
		return Math.max(0, Math.min(defaultRows, availableRows));
	}
	return clamp(availableRows, minimumRows, defaultRows);
}

export function clampRenderedRows(lines: string[], maxRows: number): string[] {
	const safeMaxRows = Math.max(0, Math.floor(maxRows));
	if (safeMaxRows === 0) {
		return [];
	}
	if (lines.length <= safeMaxRows) {
		return lines;
	}
	if (safeMaxRows === 1) {
		return ["…"];
	}
	return [...lines.slice(0, safeMaxRows - 1), "…"];
}
