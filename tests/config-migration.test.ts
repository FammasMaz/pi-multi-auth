import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	cloneMultiAuthExtensionConfig,
	DEFAULT_MULTI_AUTH_CONFIG,
	ensureMultiAuthConfig,
	loadMultiAuthConfig,
	writeMultiAuthProviderHidden,
	writeMultiAuthProviderRotationMode,
} from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempConfig<T>(fn: (configPath: string) => Promise<T>): Promise<T> {
	const tmpDir = await mkdtemp(join(tmpdir(), "pi-multi-auth-config-"));
	try {
		return await fn(join(tmpDir, "config.json"));
	} finally {
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function withTempConfigContent<T>(
	content: string,
	fn: (configPath: string) => Promise<T>,
): Promise<T> {
	return withTempConfig(async (configPath) => {
		await writeFile(configPath, content, "utf-8");
		return fn(configPath);
	});
}

// ---------------------------------------------------------------------------
// cloneMultiAuthExtensionConfig
// ---------------------------------------------------------------------------

test("cloneMultiAuthExtensionConfig returns a deep clone of defaults when called without args", () => {
	const cloned = cloneMultiAuthExtensionConfig();
	assert.deepEqual(cloned, DEFAULT_MULTI_AUTH_CONFIG);
	assert.notEqual(cloned.hiddenProviders, DEFAULT_MULTI_AUTH_CONFIG.hiddenProviders);
	assert.notEqual(cloned.rotationModes, DEFAULT_MULTI_AUTH_CONFIG.rotationModes);
});

test("cloneMultiAuthExtensionConfig clones arrays and objects", () => {
	const original = {
		debug: true,
		hiddenProviders: ["provider1", "provider2"],
		rotationModes: { provider1: "usage-based" as const },
	};
	const cloned = cloneMultiAuthExtensionConfig(original);
	assert.deepEqual(cloned, original);
	cloned.hiddenProviders.push("provider3");
	assert.equal(original.hiddenProviders.length, 2);
});

// ---------------------------------------------------------------------------
// ensureMultiAuthConfig
// ---------------------------------------------------------------------------

test("ensureMultiAuthConfig creates default config when file does not exist", async () => {
	await withTempConfig(async (configPath) => {
		const result = ensureMultiAuthConfig(configPath);
		assert.equal(result.created, true);
		assert.equal(result.warning, undefined);
		const content = await readFile(configPath, "utf-8");
		const parsed = JSON.parse(content);
		assert.equal(parsed.debug, false);
		assert.deepEqual(parsed.hiddenProviders, []);
		assert.deepEqual(parsed.rotationModes, {});
	});
});

test("ensureMultiAuthConfig does not overwrite existing config", async () => {
	await withTempConfigContent(JSON.stringify({ debug: true, hiddenProviders: ["test"], rotationModes: {} }), async (configPath) => {
		const result = ensureMultiAuthConfig(configPath);
		assert.equal(result.created, false);
		const content = await readFile(configPath, "utf-8");
		const parsed = JSON.parse(content);
		assert.equal(parsed.debug, true);
	});
});

// ---------------------------------------------------------------------------
// loadMultiAuthConfig
// ---------------------------------------------------------------------------

test("loadMultiAuthConfig loads valid config", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: true, hiddenProviders: ["p1", "p2"], rotationModes: { p1: "usage-based" } }),
		async (configPath) => {
			const result = loadMultiAuthConfig(configPath);
			assert.equal(result.config.debug, true);
			assert.deepEqual(result.config.hiddenProviders, ["p1", "p2"]);
			assert.deepEqual(result.config.rotationModes, { p1: "usage-based" });
			assert.equal(result.created, false);
		},
	);
});

test("loadMultiAuthConfig creates default config when file does not exist", async () => {
	await withTempConfig(async (configPath) => {
		const result = loadMultiAuthConfig(configPath);
		assert.equal(result.created, true);
		assert.deepEqual(result.config, DEFAULT_MULTI_AUTH_CONFIG);
	});
});

test("loadMultiAuthConfig returns defaults and warning for invalid JSON", async () => {
	await withTempConfigContent("not-json", async (configPath) => {
		const result = loadMultiAuthConfig(configPath);
		assert.deepEqual(result.config, DEFAULT_MULTI_AUTH_CONFIG);
		assert.ok(result.warning?.includes("Failed to read"));
	});
});

test("loadMultiAuthConfig returns defaults and warning for non-object JSON", async () => {
	await withTempConfigContent('"string"', async (configPath) => {
		const result = loadMultiAuthConfig(configPath);
		assert.deepEqual(result.config, DEFAULT_MULTI_AUTH_CONFIG);
	});
});

// ---------------------------------------------------------------------------
// Backward compatibility: removed keys are silently ignored
// ---------------------------------------------------------------------------

test("loadMultiAuthConfig ignores removed 'cascade' key", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: false, hiddenProviders: [], rotationModes: {}, cascade: { enabled: true } }),
		async (configPath) => {
			const result = loadMultiAuthConfig(configPath);
			assert.equal(result.config.debug, false);
			assert.equal(result.warning, undefined);
		},
	);
});

test("loadMultiAuthConfig ignores removed 'health' key", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: false, hiddenProviders: [], rotationModes: {}, health: { thresholds: {} } }),
		async (configPath) => {
			const result = loadMultiAuthConfig(configPath);
			assert.deepEqual(result.config.hiddenProviders, []);
		},
	);
});

test("loadMultiAuthConfig ignores removed 'excludeProviders' key", async () => {
	await withTempConfigContent(
		JSON.stringify({
			debug: false,
			hiddenProviders: [],
			rotationModes: {},
			excludeProviders: ["some-provider"],
		}),
		async (configPath) => {
			const result = loadMultiAuthConfig(configPath);
			// excludeProviders is not read; hiddenProviders remains default
			assert.deepEqual(result.config.hiddenProviders, []);
		},
	);
});

test("loadMultiAuthConfig ignores removed 'historyPersistence' key", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: true, hiddenProviders: [], rotationModes: {}, historyPersistence: { maxEntries: 100 } }),
		async (configPath) => {
			const result = loadMultiAuthConfig(configPath);
			assert.equal(result.config.debug, true);
		},
	);
});

test("loadMultiAuthConfig ignores removed 'modelEntitlements' key", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: false, hiddenProviders: [], rotationModes: {}, modelEntitlements: {} }),
		async (configPath) => {
			const result = loadMultiAuthConfig(configPath);
			assert.deepEqual(result.config.hiddenProviders, []);
		},
	);
});

test("loadMultiAuthConfig handles null values gracefully", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: false, hiddenProviders: null, rotationModes: null }),
		async (configPath) => {
			const result = loadMultiAuthConfig(configPath);
			assert.deepEqual(result.config.hiddenProviders, []);
			assert.deepEqual(result.config.rotationModes, {});
		},
	);
});

test("loadMultiAuthConfig handles missing hiddenProviders gracefully", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: true }),
		async (configPath) => {
			const result = loadMultiAuthConfig(configPath);
			assert.equal(result.config.debug, true);
			assert.deepEqual(result.config.hiddenProviders, []);
			assert.deepEqual(result.config.rotationModes, {});
		},
	);
});

// ---------------------------------------------------------------------------
// writeMultiAuthProviderHidden
// ---------------------------------------------------------------------------

test("writeMultiAuthProviderHidden adds provider to hiddenProviders", async () => {
	await withTempConfig(async (configPath) => {
		const result = writeMultiAuthProviderHidden("myprovider", true, configPath);
		assert.ok(result.includes("myprovider"));
		// Verify persisted
		const loaded = loadMultiAuthConfig(configPath);
		assert.ok(loaded.config.hiddenProviders.includes("myprovider"));
	});
});

test("writeMultiAuthProviderHidden removes provider from hiddenProviders", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: false, hiddenProviders: ["p1", "p2"], rotationModes: {} }),
		async (configPath) => {
			const result = writeMultiAuthProviderHidden("p1", false, configPath);
			assert.equal(result.includes("p1"), false);
			assert.ok(result.includes("p2"));
		},
	);
});

test("writeMultiAuthProviderHidden validates provider id", async () => {
	await withTempConfig(async (configPath) => {
		assert.throws(
			() => writeMultiAuthProviderHidden("", true, configPath),
			/Provider id is required/,
		);
		assert.throws(
			() => writeMultiAuthProviderHidden("   ", true, configPath),
			/Provider id is required/,
		);
	});
});

test("writeMultiAuthProviderHidden deduplicates hiddenProviders", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: false, hiddenProviders: ["p1", "p1", "p2"], rotationModes: {} }),
		async (configPath) => {
			const result = writeMultiAuthProviderHidden("p2", true, configPath);
			const loaded = loadMultiAuthConfig(configPath);
			// p1 should be deduplicated to one entry
			const p1Count = loaded.config.hiddenProviders.filter((p: string) => p === "p1").length;
			assert.equal(p1Count, 1);
		},
	);
});

// ---------------------------------------------------------------------------
// writeMultiAuthProviderRotationMode
// ---------------------------------------------------------------------------

test("writeMultiAuthProviderRotationMode writes rotation mode", async () => {
	await withTempConfig(async (configPath) => {
		const result = writeMultiAuthProviderRotationMode("provider1", "usage-based", configPath);
		assert.deepEqual(result, { provider1: "usage-based" });
		const loaded = loadMultiAuthConfig(configPath);
		assert.equal(loaded.config.rotationModes.provider1, "usage-based");
	});
});

test("writeMultiAuthProviderRotationMode preserves existing rotation modes", async () => {
	await withTempConfigContent(
		JSON.stringify({ debug: false, hiddenProviders: [], rotationModes: { existing: "round-robin" } }),
		async (configPath) => {
			const result = writeMultiAuthProviderRotationMode("new", "balancer", configPath);
			assert.equal(result.existing, "round-robin");
			assert.equal(result.new, "balancer");
		},
	);
});

test("writeMultiAuthProviderRotationMode validates provider id", async () => {
	await withTempConfig(async (configPath) => {
		assert.throws(
			() => writeMultiAuthProviderRotationMode("", "usage-based", configPath),
			/Provider id is required/,
		);
	});
});

test("writeMultiAuthProviderRotationMode validates rotation mode", async () => {
	await withTempConfig(async (configPath) => {
		assert.throws(
			() => writeMultiAuthProviderRotationMode("p1", "invalid" as "usage-based", configPath),
			/Invalid rotation mode/,
		);
	});
});

test("writeMultiAuthProviderRotationMode normalizes provider id whitespace", async () => {
	await withTempConfig(async (configPath) => {
		const result = writeMultiAuthProviderRotationMode("  spaced  ", "usage-based", configPath);
		assert.ok(result.spaced !== undefined);
		assert.equal(result.spaced, "usage-based");
	});
});
