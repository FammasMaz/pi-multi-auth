import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let exitCode = 0;

function assert(condition, message) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		exitCode = 1;
	} else {
		console.log(`PASS: ${message}`);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function collectTsFiles(dir, files = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(full, files);
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(full);
		}
	}
	return files;
}

function main() {
	console.log("=== Smoke Test ===\n");

	// Validate package.json
	const pkg = readJson(resolve(EXTENSION_ROOT, "package.json"));
	assert(pkg.name === "pi-multi-auth", "package.json name is pi-multi-auth");
	assert(typeof pkg.version === "string" && pkg.version.length > 0, "package.json has version");
	assert(typeof pkg.main === "string" && pkg.main.length > 0, "package.json has main");
	assert(Array.isArray(pkg.pi?.extensions), "package.json has pi.extensions array");

	for (const ext of pkg.pi.extensions) {
		const extPath = resolve(EXTENSION_ROOT, ext);
		assert(existsSync(extPath), `pi.extension path exists: ${ext}`);
	}

	// Validate index.ts exists
	assert(existsSync(resolve(EXTENSION_ROOT, "index.ts")), "index.ts exists");

	// Validate config.json is parseable (dev sanity)
	const configPath = resolve(EXTENSION_ROOT, "config.json");
	if (existsSync(configPath)) {
		const config = readJson(configPath);
		assert(typeof config === "object" && config !== null, "config.json is valid JSON object");
	} else {
		console.log("SKIP: config.json not found (may be excluded from package)");
	}

	// Validate npm pack dry-run excludes debug/config/tests
	const packResult = spawnSync("npm", ["pack", "--dry-run"], {
		encoding: "utf-8",
		cwd: EXTENSION_ROOT,
		shell: process.platform === "win32",
	});
	assert(packResult.status === 0, "npm pack --dry-run exits 0");
	const packOutput = packResult.stdout + packResult.stderr;
	const forbidden = ["config.json", "debug/", "tests/", ".test-dist"];
	for (const item of forbidden) {
		assert(!packOutput.includes(item), `npm pack --dry-run does not include ${item}`);
	}

	// Validate no forbidden console.* usage in src/ and index.ts (per Pi extension standards)
	const srcDir = resolve(EXTENSION_ROOT, "src");
	const sourceFiles = existsSync(srcDir) ? collectTsFiles(srcDir) : [];
	sourceFiles.push(resolve(EXTENSION_ROOT, "index.ts"));
	let consoleFound = false;
	for (const file of sourceFiles) {
		const content = readFileSync(file, "utf-8");
		// Match console.(log|debug|info|warn|error)(
		if (/console\.(log|debug|info|warn|error)\s*\(/.test(content)) {
			console.error(`FAIL: Console usage found in ${file}`);
			consoleFound = true;
		}
	}
	if (!consoleFound) {
		console.log("PASS: No console.* usage found in extension source");
	} else {
		exitCode = 1;
	}

	console.log("\n=== Smoke Test Complete ===");
	process.exit(exitCode);
}

main();
