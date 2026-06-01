import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	backupBeforeOverwrite,
	hardenCredentialFilePermissions,
	readTextSnapshotWithBackupRecovery,
	writeTextFileAtomically,
} from "../src/file-utils.js";

test("writeTextFileAtomically replaces files without leaving temp siblings", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-atomic-write-"));
	const filePath = join(tempRoot, "snapshot.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await writeFile(filePath, "old", "utf-8");
	await writeTextFileAtomically(filePath, "new");

	assert.equal(await readFile(filePath, "utf-8"), "new");
	assert.deepEqual(
		(await readdir(tempRoot)).filter((entry) => entry.includes(".tmp")),
		[],
	);
});

test("writeTextFileAtomically cleans up temp file and preserves target when rename fails", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-atomic-fail-"));
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	// Create a directory path so rename(fsPath, dirPath) will fail
	const dirPath = join(tempRoot, "dir-target");
	const nestedFile = join(dirPath, "nested.json");
	await mkdir(dirPath, { recursive: true });
	await writeFile(nestedFile, "nested content", "utf-8");

	// Attempt to write atomically to the directory path — writeFile to the temp path
	// succeeds, but rename(tempPath, dirPath) fails because dirPath is a directory
	await assert.rejects(
		writeTextFileAtomically(dirPath, "this should fail atomically"),
	);

	// The nested file inside the directory must be intact
	assert.equal(await readFile(nestedFile, "utf-8"), "nested content");

	// No .tmp files should remain in the parent directory after cleanup
	const tmpFiles = (await readdir(tempRoot)).filter((entry) =>
		entry.includes(".tmp"),
	);
	assert.deepEqual(tmpFiles, [], "Expected no .tmp files to remain after failed rename");

	// Verify directory structure is unchanged
	assert.ok((await stat(dirPath)).isDirectory(), "Target directory must still exist");
});

test("writeTextFileAtomically writes a file from scratch when no prior file exists", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-atomic-new-"));
	const filePath = join(tempRoot, "new-file.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await writeTextFileAtomically(filePath, "fresh content");

	assert.equal(await readFile(filePath, "utf-8"), "fresh content");
	assert.deepEqual(
		(await readdir(tempRoot)).filter((entry) => entry.includes(".tmp")),
		[],
	);
});

test("writeTextFileAtomically creates a one-generation backup before overwrite", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-backup-write-"));
	const filePath = join(tempRoot, "snapshot.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await writeFile(filePath, "first", "utf-8");
	await writeTextFileAtomically(filePath, "second");

	assert.equal(await readFile(filePath, "utf-8"), "second");
	assert.equal(await readFile(`${filePath}.bak`, "utf-8"), "first");
});

test("backupBeforeOverwrite is a no-op when the primary file is missing", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-backup-missing-"));
	const filePath = join(tempRoot, "missing.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await backupBeforeOverwrite(filePath);

	await assert.rejects(readFile(`${filePath}.bak`, "utf-8"), /ENOENT/);
});

test("readTextSnapshotWithBackupRecovery restores valid backup after corrupted primary", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-backup-recover-"));
	const filePath = join(tempRoot, "snapshot.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await writeFile(filePath, "{", "utf-8");
	await writeFile(`${filePath}.bak`, JSON.stringify({ ok: true }), "utf-8");

	const recovered = await readTextSnapshotWithBackupRecovery({
		filePath,
		parse: (content) => JSON.parse(content ?? "{}") as { ok?: boolean },
		createDefault: () => ({ ok: false }),
	});

	assert.deepEqual(recovered, { ok: true });
	assert.equal(await readFile(filePath, "utf-8"), JSON.stringify({ ok: true }));
});

test("readTextSnapshotWithBackupRecovery returns default when backup is corrupted", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-backup-corrupt-"));
	const filePath = join(tempRoot, "snapshot.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await writeFile(filePath, "{", "utf-8");
	await writeFile(`${filePath}.bak`, "{", "utf-8");

	const recovered = await readTextSnapshotWithBackupRecovery({
		filePath,
		parse: (content) => JSON.parse(content ?? "{}") as { ok: boolean },
		createDefault: () => ({ ok: false }),
	});

	assert.deepEqual(recovered, { ok: false });
});

test("readTextSnapshotWithBackupRecovery rejects stale backup and returns default", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-stale-backup-"));
	const filePath = join(tempRoot, "snapshot.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	// Create a valid backup
	await writeFile(`${filePath}.bak`, JSON.stringify({ ok: true }), "utf-8");

	// Set backup mtime to be very old (1 hour ago) so maxAgeMs=100 rejects it
	const oldTime = new Date(Date.now() - 3_600_000);
	await utimes(`${filePath}.bak`, oldTime, oldTime);

	// Write corrupted primary to trigger backup recovery attempt
	await writeFile(filePath, "{", "utf-8");

	const recovered = await readTextSnapshotWithBackupRecovery({
		filePath,
		maxAgeMs: 100,
		parse: (content) => JSON.parse(content ?? "{}") as { ok?: boolean },
		createDefault: () => ({ ok: false }),
	});

	assert.deepEqual(recovered, { ok: false }, "Expected default when backup is stale");
});

test("hardenCredentialFilePermissions preserves private owner permissions", async (t) => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-multi-auth-permissions-"));
	const filePath = join(tempRoot, "credential.json");
	t.after(async () => {
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	await writeFile(filePath, "secret", "utf-8");
	await hardenCredentialFilePermissions(filePath);

	const mode = (await stat(filePath)).mode & 0o777;
	if (process.platform !== "win32") {
		assert.equal(mode, 0o600);
	}
});
