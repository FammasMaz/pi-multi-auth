import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { getErrorMessage, isRecord, normalizeNonEmptyString } from "./auth-error-utils.js";
import { extractCodexCredentialIdentity } from "./openai-codex-identity.js";
import { determineTokenExpiration } from "./oauth-refresh-scheduler.js";
import type { OAuthCredentials } from "./oauth-compat.js";

export const OPENAI_CODEX_IMPORT_PROVIDER_ID = "openai-codex";

const IMPORT_SOURCE_LABEL = "OpenAI Codex CPA/Sub2API JSON";
const CSV_ACCESS_TOKEN_HEADER = "accesstoken";
const CSV_REFRESH_TOKEN_HEADER = "refreshtoken";
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const ZIP_LOCAL_FILE_HEADER_SIZE = 30;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIZE = 46;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const ZIP_COMPRESSION_STORE = 0;
const ZIP_COMPRESSION_DEFLATE = 8;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_TEXT_ENTRY_PATTERN = /\.(?:json|csv)$/i;
const ZIP_FILE_PATH_PATTERN = /\.zip$/i;

const inflateRawAsync = promisify(inflateRaw) as (buffer: Buffer) => Promise<Buffer>;

export type OpenAICodexImportFormat = "json" | "csv" | "zip";

export type OpenAICodexImportCredential = OAuthCredentials & {
	accountId: string;
	email?: string;
	clientId?: string;
	idToken?: string;
	sessionToken?: string;
	workspaceId?: string;
};

export interface ParsedOpenAICodexCredentialImport {
	format: OpenAICodexImportFormat;
	credentials: OpenAICodexImportCredential[];
	duplicateCount: number;
	ignoredLineCount: number;
	invalidRecordCount: number;
	invalidRecordMessages: string[];
}

export type OpenAICodexCredentialImportParseResult =
	| {
		ok: true;
		parsed: ParsedOpenAICodexCredentialImport;
	}
	| {
		ok: false;
		message: string;
	};

function stripMarkdownFenceLines(value: string): { value: string; ignoredLineCount: number } {
	const normalized = value.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const retainedLines: string[] = [];
	let ignoredLineCount = 0;

	for (const line of lines) {
		if (line.trim().startsWith("```")) {
			ignoredLineCount += 1;
			continue;
		}
		retainedLines.push(line);
	}

	return {
		value: retainedLines.join("\n").trim(),
		ignoredLineCount,
	};
}

function normalizeRecordKey(key: string): string {
	return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getRecordField(record: Record<string, unknown>, names: readonly string[]): unknown {
	for (const name of names) {
		if (Object.prototype.hasOwnProperty.call(record, name)) {
			return record[name];
		}
	}

	const normalizedNames = new Set(names.map(normalizeRecordKey));
	for (const [key, value] of Object.entries(record)) {
		if (normalizedNames.has(normalizeRecordKey(key))) {
			return value;
		}
	}

	return undefined;
}

function getStringField(record: Record<string, unknown>, names: readonly string[]): string | undefined {
	const value = getRecordField(record, names);
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return normalizeNonEmptyString(value);
}

function parsePositiveNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	if (!normalized) {
		return undefined;
	}
	const parsed = Number(normalized);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseExpirationTimestampMs(value: unknown): number | undefined {
	const numeric = parsePositiveNumber(value);
	if (numeric !== undefined) {
		return Math.trunc(numeric > 1_000_000_000_000 ? numeric : numeric * 1000);
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const parsed = Date.parse(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveImportedExpiration(record: Record<string, unknown>, accessToken: string): number {
	const expiresAt = parseExpirationTimestampMs(
		getRecordField(record, [
			"expires",
			"expires_at",
			"expiresAt",
			"expires_at_unix",
			"expiresAtUnix",
			"expired",
			"expiration",
		]),
	);
	const expiresIn = parsePositiveNumber(getRecordField(record, ["expires_in", "expiresIn"]));
	return determineTokenExpiration(accessToken, expiresAt, expiresIn).expiresAt;
}

function flattenCredentialRecord(record: Record<string, unknown>): Record<string, unknown> {
	const credentials = isRecord(record.credentials) ? record.credentials : undefined;
	return credentials ? { ...record, ...credentials } : record;
}

function toImportCredential(
	record: Record<string, unknown>,
	ordinal: number,
): { ok: true; credential: OpenAICodexImportCredential } | { ok: false; message: string } {
	const flattened = flattenCredentialRecord(record);
	const access = getStringField(flattened, ["access", "access_token", "accessToken", "token"]);
	const refresh = getStringField(flattened, ["refresh", "refresh_token", "refreshToken"]);

	if (!access) {
		return { ok: false, message: `Record #${ordinal} is missing access_token.` };
	}
	if (!refresh) {
		return { ok: false, message: `Record #${ordinal} is missing refresh_token.` };
	}

	const accountId = getStringField(flattened, [
		"accountId",
		"account_id",
		"chatgptAccountId",
		"chatgpt_account_id",
	]);
	const email = getStringField(flattened, ["email", "name"]);
	const identity = extractCodexCredentialIdentity({ access, accountId, email });
	const resolvedAccountId = accountId ?? identity.accountId ?? undefined;
	if (!resolvedAccountId) {
		return {
			ok: false,
			message: `Record #${ordinal} is missing account_id and the access token did not contain a ChatGPT account identity.`,
		};
	}

	const clientId = getStringField(flattened, ["clientId", "client_id"]);
	const idToken = getStringField(flattened, ["idToken", "id_token"]);
	const sessionToken = getStringField(flattened, ["sessionToken", "session_token"]);
	const workspaceId = getStringField(flattened, [
		"workspaceId",
		"workspace_id",
		"organizationId",
		"organization_id",
	]);
	const resolvedEmail = email ?? identity.email ?? undefined;
	const credential: OpenAICodexImportCredential = {
		access,
		refresh,
		expires: resolveImportedExpiration(flattened, access),
		accountId: resolvedAccountId,
		...(resolvedEmail && { email: resolvedEmail }),
		...(clientId && { clientId }),
		...(idToken && { idToken }),
		...(sessionToken && { sessionToken }),
		...(workspaceId && { workspaceId }),
	};

	return { ok: true, credential };
}

function collectJsonCredentialRecords(value: unknown): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	const visit = (item: unknown): void => {
		if (Array.isArray(item)) {
			for (const child of item) {
				visit(child);
			}
			return;
		}
		if (!isRecord(item)) {
			return;
		}

		if (Array.isArray(item.accounts)) {
			for (const account of item.accounts) {
				if (!isRecord(account)) {
					continue;
				}
				const credentials = isRecord(account.credentials) ? account.credentials : {};
				records.push({ ...account, ...credentials });
			}
			return;
		}

		records.push(flattenCredentialRecord(item));
	};

	visit(value);
	return records;
}

function parseCsvRows(value: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char === '"') {
			if (inQuotes && value[index + 1] === '"') {
				field += '"';
				index += 1;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}
		if (char === "," && !inQuotes) {
			row.push(field);
			field = "";
			continue;
		}
		if ((char === "\n" || char === "\r") && !inQuotes) {
			if (char === "\r" && value[index + 1] === "\n") {
				index += 1;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			continue;
		}
		field += char;
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

function csvRowsToRecords(rows: string[][]): { records: Record<string, unknown>[]; ignoredLineCount: number } | null {
	const nonEmptyRows = rows.filter((row) => row.some((field) => field.trim().length > 0));
	if (nonEmptyRows.length < 2) {
		return null;
	}

	const headers = nonEmptyRows[0]?.map((header) => header.replace(/^\uFEFF/, "").trim()) ?? [];
	const normalizedHeaders = new Set(headers.map(normalizeRecordKey));
	if (!normalizedHeaders.has(CSV_ACCESS_TOKEN_HEADER) || !normalizedHeaders.has(CSV_REFRESH_TOKEN_HEADER)) {
		return null;
	}

	const records: Record<string, unknown>[] = [];
	for (const row of nonEmptyRows.slice(1)) {
		const record: Record<string, unknown> = {};
		for (const [index, header] of headers.entries()) {
			if (!header) {
				continue;
			}
			record[header] = row[index] ?? "";
		}
		records.push(record);
	}

	return {
		records,
		ignoredLineCount: rows.length - nonEmptyRows.length,
	};
}

function buildCredentialDeduplicationKey(credential: OpenAICodexImportCredential): string {
	const identity = extractCodexCredentialIdentity(credential);
	if (identity.accountId) {
		return `account:${identity.accountId.toLowerCase()}`;
	}
	if (identity.accountUserId) {
		return `user:${identity.accountUserId.toLowerCase()}`;
	}
	if (identity.email) {
		return `email:${identity.email.toLowerCase()}`;
	}
	return `refresh:${credential.refresh}`;
}

function buildParsedImport(
	records: readonly Record<string, unknown>[],
	format: OpenAICodexImportFormat,
	ignoredLineCount: number,
): OpenAICodexCredentialImportParseResult {
	const credentials: OpenAICodexImportCredential[] = [];
	const seenCredentials = new Set<string>();
	const invalidRecordMessages: string[] = [];
	let duplicateCount = 0;

	for (const [index, record] of records.entries()) {
		const parsedCredential = toImportCredential(record, index + 1);
		if (!parsedCredential.ok) {
			invalidRecordMessages.push(parsedCredential.message);
			continue;
		}

		const deduplicationKey = buildCredentialDeduplicationKey(parsedCredential.credential);
		if (seenCredentials.has(deduplicationKey)) {
			duplicateCount += 1;
			continue;
		}
		seenCredentials.add(deduplicationKey);
		credentials.push(parsedCredential.credential);
	}

	if (credentials.length === 0) {
		const invalidHint = invalidRecordMessages[0]
			? ` First invalid record: ${invalidRecordMessages[0]}`
			: "";
		return {
			ok: false,
			message: `No importable OpenAI Codex credentials found. Paste a ${IMPORT_SOURCE_LABEL} JSON or CSV export with access_token and refresh_token.${invalidHint}`,
		};
	}

	return {
		ok: true,
		parsed: {
			format,
			credentials,
			duplicateCount,
			ignoredLineCount,
			invalidRecordCount: invalidRecordMessages.length,
			invalidRecordMessages: invalidRecordMessages.slice(0, 5),
		},
	};
}

interface ZipTextEntry {
	name: string;
	content: string;
}

function normalizeZipImportPathInput(value: string): string | null {
	const stripped = stripMarkdownFenceLines(value).value;
	if (!stripped || /[\r\n]/.test(stripped)) {
		return null;
	}

	let candidate = stripped.trim();
	const firstCharacter = candidate[0];
	const lastCharacter = candidate[candidate.length - 1];
	if (
		((firstCharacter === '"' && lastCharacter === '"') ||
			(firstCharacter === "'" && lastCharacter === "'")) &&
		candidate.length >= 2
	) {
		candidate = candidate.slice(1, -1).trim();
	}

	let localPath = candidate;
	if (/^file:/i.test(candidate)) {
		try {
			localPath = fileURLToPath(candidate);
		} catch {
			return null;
		}
	}

	return ZIP_FILE_PATH_PATTERN.test(localPath) ? localPath : null;
}

function assertZipRange(buffer: Buffer, offset: number, length: number, message: string): void {
	if (offset < 0 || length < 0 || offset + length > buffer.length) {
		throw new Error(message);
	}
}

function findEndOfCentralDirectoryOffset(buffer: Buffer): number {
	if (buffer.length < ZIP_END_OF_CENTRAL_DIRECTORY_SIZE) {
		return -1;
	}

	const minimumOffset = Math.max(
		0,
		buffer.length - ZIP_END_OF_CENTRAL_DIRECTORY_SIZE - ZIP_MAX_COMMENT_LENGTH,
	);
	for (let offset = buffer.length - ZIP_END_OF_CENTRAL_DIRECTORY_SIZE; offset >= minimumOffset; offset -= 1) {
		if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
			return offset;
		}
	}
	return -1;
}

function decodeZipEntryName(nameBytes: Buffer): string {
	return nameBytes.toString("utf8");
}

async function inflateZipEntry(name: string, method: number, compressedContent: Buffer): Promise<Buffer> {
	if (method === ZIP_COMPRESSION_STORE) {
		return compressedContent;
	}
	if (method === ZIP_COMPRESSION_DEFLATE) {
		return inflateRawAsync(compressedContent);
	}
	throw new Error(`ZIP entry '${name}' uses unsupported compression method ${method}.`);
}

async function readZipTextEntries(zipPath: string): Promise<ZipTextEntry[]> {
	const resolvedPath = resolve(zipPath);
	let stats;
	try {
		stats = await stat(resolvedPath);
	} catch (error: unknown) {
		throw new Error(`Could not read ZIP import path '${zipPath}': ${getErrorMessage(error)}`);
	}
	if (!stats.isFile()) {
		throw new Error(`ZIP import path '${zipPath}' is not a file.`);
	}

	const buffer = await readFile(resolvedPath);
	const eocdOffset = findEndOfCentralDirectoryOffset(buffer);
	if (eocdOffset < 0) {
		throw new Error(`ZIP import path '${zipPath}' is not a valid ZIP archive.`);
	}

	const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
	const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
	const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
	if (totalEntries === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
		throw new Error("ZIP64 OpenAI Codex import archives are not supported.");
	}
	assertZipRange(
		buffer,
		centralDirectoryOffset,
		centralDirectorySize,
		`ZIP import path '${zipPath}' has an invalid central directory.`,
	);

	const entries: ZipTextEntry[] = [];
	let offset = centralDirectoryOffset;
	for (let index = 0; index < totalEntries; index += 1) {
		assertZipRange(
			buffer,
			offset,
			ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIZE,
			`ZIP import path '${zipPath}' has a truncated central directory entry.`,
		);
		if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE) {
			throw new Error(`ZIP import path '${zipPath}' has an invalid central directory entry.`);
		}

		const flags = buffer.readUInt16LE(offset + 8);
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localHeaderOffset = buffer.readUInt32LE(offset + 42);
		const entryLength = ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIZE + nameLength + extraLength + commentLength;
		assertZipRange(
			buffer,
			offset,
			entryLength,
			`ZIP import path '${zipPath}' has a truncated central directory entry.`,
		);

		const name = decodeZipEntryName(
			buffer.subarray(
				offset + ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIZE,
				offset + ZIP_CENTRAL_DIRECTORY_FILE_HEADER_SIZE + nameLength,
			),
		);
		offset += entryLength;

		if (name.endsWith("/") || !ZIP_TEXT_ENTRY_PATTERN.test(name)) {
			continue;
		}
		if ((flags & ZIP_ENCRYPTED_FLAG) !== 0) {
			throw new Error(`ZIP entry '${name}' is encrypted and cannot be imported.`);
		}
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
			throw new Error("ZIP64 OpenAI Codex import entries are not supported.");
		}

		assertZipRange(
			buffer,
			localHeaderOffset,
			ZIP_LOCAL_FILE_HEADER_SIZE,
			`ZIP entry '${name}' has a truncated local file header.`,
		);
		if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
			throw new Error(`ZIP entry '${name}' has an invalid local file header.`);
		}

		const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
		const dataOffset = localHeaderOffset + ZIP_LOCAL_FILE_HEADER_SIZE + localNameLength + localExtraLength;
		assertZipRange(
			buffer,
			dataOffset,
			compressedSize,
			`ZIP entry '${name}' has truncated compressed content.`,
		);

		const content = await inflateZipEntry(
			name,
			method,
			buffer.subarray(dataOffset, dataOffset + compressedSize),
		);
		if (content.length !== uncompressedSize) {
			throw new Error(`ZIP entry '${name}' decompressed to an unexpected size.`);
		}
		entries.push({
			name,
			content: content.toString("utf8"),
		});
	}

	return entries;
}

function mergeZipCredentialImports(
	entries: readonly ZipTextEntry[],
	zipPath: string,
): OpenAICodexCredentialImportParseResult {
	if (entries.length === 0) {
		return {
			ok: false,
			message: `No JSON or CSV credential files were found in ZIP import path '${zipPath}'.`,
		};
	}

	const credentials: OpenAICodexImportCredential[] = [];
	const seenCredentials = new Set<string>();
	const invalidRecordMessages: string[] = [];
	let duplicateCount = 0;
	let ignoredLineCount = 0;
	let invalidRecordCount = 0;

	for (const entry of entries) {
		const parsedEntry = parseOpenAICodexCredentialImport(entry.content);
		if (!parsedEntry.ok) {
			invalidRecordCount += 1;
			invalidRecordMessages.push(`${entry.name}: ${parsedEntry.message}`);
			continue;
		}

		ignoredLineCount += parsedEntry.parsed.ignoredLineCount;
		duplicateCount += parsedEntry.parsed.duplicateCount;
		invalidRecordCount += parsedEntry.parsed.invalidRecordCount;
		for (const message of parsedEntry.parsed.invalidRecordMessages) {
			invalidRecordMessages.push(`${entry.name}: ${message}`);
		}

		for (const credential of parsedEntry.parsed.credentials) {
			const deduplicationKey = buildCredentialDeduplicationKey(credential);
			if (seenCredentials.has(deduplicationKey)) {
				duplicateCount += 1;
				continue;
			}
			seenCredentials.add(deduplicationKey);
			credentials.push(credential);
		}
	}

	if (credentials.length === 0) {
		const invalidHint = invalidRecordMessages[0]
			? ` First invalid ZIP entry: ${invalidRecordMessages[0]}`
			: "";
		return {
			ok: false,
			message: `No importable OpenAI Codex credentials found in ZIP import path '${zipPath}'.${invalidHint}`,
		};
	}

	return {
		ok: true,
		parsed: {
			format: "zip",
			credentials,
			duplicateCount,
			ignoredLineCount,
			invalidRecordCount,
			invalidRecordMessages: invalidRecordMessages.slice(0, 5),
		},
	};
}

export function parseOpenAICodexCredentialImport(
	value: string,
): OpenAICodexCredentialImportParseResult {
	const stripped = stripMarkdownFenceLines(value);
	if (!stripped.value) {
		return {
			ok: false,
			message: `Paste a ${IMPORT_SOURCE_LABEL} JSON or CSV export.`,
		};
	}

	try {
		const parsedJson = JSON.parse(stripped.value) as unknown;
		const records = collectJsonCredentialRecords(parsedJson);
		return buildParsedImport(records, "json", stripped.ignoredLineCount);
	} catch {
		// Fall through to CSV parsing. Workflow exports can be copied as JSON or CSV.
	}

	const csvRecords = csvRowsToRecords(parseCsvRows(stripped.value));
	if (csvRecords) {
		return buildParsedImport(
			csvRecords.records,
			"csv",
			stripped.ignoredLineCount + csvRecords.ignoredLineCount,
		);
	}

	return {
		ok: false,
		message: `Unsupported OpenAI Codex import format. Paste a ${IMPORT_SOURCE_LABEL} JSON array, CPA JSON, Sub2API JSON, CSV export, or a path to a .zip export.`,
	};
}

export async function parseOpenAICodexCredentialImportInput(
	value: string,
): Promise<OpenAICodexCredentialImportParseResult> {
	const zipPath = normalizeZipImportPathInput(value);
	if (!zipPath) {
		return parseOpenAICodexCredentialImport(value);
	}

	try {
		return mergeZipCredentialImports(await readZipTextEntries(zipPath), zipPath);
	} catch (error: unknown) {
		return {
			ok: false,
			message: getErrorMessage(error),
		};
	}
}
