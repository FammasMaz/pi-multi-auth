import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORCE = process.argv.includes("--force");

const FORBIDDEN_PACKAGE_PATTERNS = [
	"config.json",
	"debug/",
	"tests/",
	".test-dist",
	".env",
	".env.*",
	"coverage/",
];

// Public template files that are safe to include in the package.
// Real secret .env files are blocked by .gitignore and the patterns above;
// .env.example contains only commented documentation with no real secrets.
const ALLOWED_ENV_TEMPLATES = new Set([".env.example"]);

function run(command, args, options = {}) {
	const shell = process.platform === "win32";
	// Avoid DEP0190: do not pass args array when shell is true.
	const cmd = shell && args.length > 0 ? `${command} ${args.join(" ")}` : command;
	const finalArgs = shell && args.length > 0 ? [] : args;
	const result = spawnSync(cmd, finalArgs, {
		stdio: options.capture ? "pipe" : "inherit",
		shell,
		cwd: EXTENSION_ROOT,
		encoding: options.capture ? "utf-8" : undefined,
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function checkDirtyWorktree() {
	const result = spawnSync("git", ["status", "--porcelain"], {
		encoding: "utf-8",
		cwd: EXTENSION_ROOT,
	});
	if (result.error) {
		console.error("ERROR: Failed to check git status:", result.error.message);
		process.exit(1);
	}
	const dirty = result.stdout.trim();
	if (dirty) {
		if (FORCE) {
			console.warn("WARNING: Bypassing dirty worktree check due to --force.");
		} else {
			console.warn("WARNING: Dirty worktree detected. This will not affect package safety because npm pack respects .gitignore and the files array, but a clean worktree is recommended for releases:");
			console.warn(dirty);
		}
	} else {
		console.log("OK: Worktree is clean.");
	}
}

function checkDebugConfig() {
	const configPath = resolve(EXTENSION_ROOT, "config.json");
	let debugEnabled = false;
	try {
		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		debugEnabled = config.debug === true;
	} catch {
		// config.json may be absent; package safety is enforced elsewhere.
	}
	if (debugEnabled) {
		console.warn("WARNING: config.json has debug=true locally. This will not ship because config.json is excluded from the package.");
	} else {
		console.log("OK: Local debug state is disabled (or config.json is absent).");
	}
}

function checkPackageManifestSafety() {
	const pkgPath = resolve(EXTENSION_ROOT, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	const files = Array.isArray(pkg.files) ? pkg.files : [];
	let ok = true;

	for (const pattern of FORBIDDEN_PACKAGE_PATTERNS) {
		for (const f of files) {
			if (ALLOWED_ENV_TEMPLATES.has(f)) {
				continue;
			}
			if (f === pattern || f.startsWith(pattern)) {
				console.error(`ERROR: package.json files array includes forbidden pattern: ${pattern}`);
				ok = false;
			}
		}
	}
	if (pkg.main === "config.json" || (typeof pkg.main === "string" && pkg.main.includes("config.json"))) {
		console.error("ERROR: package.json main must not point to config.json");
		ok = false;
	}

	const exportsObj = pkg.exports || {};
	for (const [key, val] of Object.entries(exportsObj)) {
		if (typeof val === "string" && val.includes("config.json")) {
			console.error(`ERROR: package.json exports.${key} must not point to config.json`);
			ok = false;
		}
	}

	if (ok) {
		console.log("OK: Package manifest does not include forbidden patterns.");
	} else {
		process.exit(1);
	}
}

function checkPackDryRun() {
	const result = run("npm", ["pack", "--dry-run"], { capture: true });
	if (result.status !== 0) {
		console.error("ERROR: npm pack --dry-run failed.");
		process.exit(1);
	}
	const output = (result.stdout || "") + (result.stderr || "");
	let ok = true;
	for (const pattern of FORBIDDEN_PACKAGE_PATTERNS) {
		if (output.includes(pattern)) {
			// Allow .env.example (public template) in pack output even though
			// it contains the .env substring matched by the forbidden pattern.
			// Only fail if a real .env (not .env.example) is present.
			if (pattern === ".env" || pattern === ".env.*") {
				// Check if the only .env matches are .env.example lines.
				const lines = output.split(/\r?\n/);
				const envLines = lines.filter((l) => l.includes(".env") && !l.includes(".env.example"));
				if (envLines.length === 0) {
					continue; // only .env.example found — safe
				}
			}
			console.error(`ERROR: npm pack --dry-run output includes forbidden pattern: ${pattern}`);
			ok = false;
		}
	}
	if (ok) {
		console.log("OK: npm pack --dry-run does not include forbidden patterns.");
	} else {
		process.exit(1);
	}
}

function main() {
	console.log("=== Release Gate ===\n");

	console.log("Step 1: Dirty worktree check (informational)");
	checkDirtyWorktree();
	console.log("");

	console.log("Step 2: Debug config check (informational)");
	checkDebugConfig();
	console.log("");

	console.log("Step 3: Package manifest safety check (fatal)");
	checkPackageManifestSafety();
	console.log("");

	console.log("Step 4: npm run check (fatal)");
	if (run("npm", ["run", "check"]).status !== 0) {
		process.exit(1);
	}
	console.log("");

	console.log("Step 5: npm pack --dry-run validation (fatal)");
	checkPackDryRun();
	console.log("");

	console.log("=== Release Gate PASSED ===");
}

main();
