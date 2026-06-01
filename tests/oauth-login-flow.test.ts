import test from "node:test";
import assert from "node:assert/strict";
import {
	MANUAL_CODE_INPUT_PROMPT,
	OAuthDialogCallbackBridge,
	formatOAuthLoginSuccessMessage,
} from "../src/oauth-login-flow.js";
import type { OAuthDeviceCodeInfo } from "../src/oauth-compat.js";

class StubOAuthDialog {
	readonly signal = new AbortController().signal;
	readonly authCalls: Array<{ url: string; instructions?: string }> = [];
	readonly promptCalls: Array<{ message: string; placeholder?: string }> = [];
	readonly manualInputCalls: string[] = [];
	readonly waitingMessages: string[] = [];
	readonly progressMessages: string[] = [];
	promptResult = "";
	manualInputResult = "";

	showAuth(url: string, instructions?: string): void {
		this.authCalls.push({ url, instructions });
	}

	async showPrompt(message: string, placeholder?: string): Promise<string> {
		this.promptCalls.push({ message, placeholder });
		return this.promptResult;
	}

	async showManualInput(prompt: string): Promise<string> {
		this.manualInputCalls.push(prompt);
		return this.manualInputResult;
	}

	showWaiting(message: string): void {
		this.waitingMessages.push(message);
	}

	showProgress(message: string): void {
		this.progressMessages.push(message);
	}
}

test("OAuth dialog bridge forwards auth details and resets waiting after re-auth steps", async () => {
	const dialog = new StubOAuthDialog();
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	callbacks.onProgress?.("Waiting for device confirmation...");
	callbacks.onAuth({
		url: "https://example.com/device",
		instructions: "Open the browser and approve access.",
	});
	callbacks.onProgress?.("Polling for OAuth approval...");

	assert.deepEqual(dialog.authCalls, [
		{
			url: "https://example.com/device",
			instructions: "Open the browser and approve access.",
		},
	]);
	assert.deepEqual(dialog.waitingMessages, [
		"Waiting for device confirmation...",
		"Polling for OAuth approval...",
	]);
	assert.deepEqual(dialog.progressMessages, []);
});

test("OAuth dialog bridge switches from waiting to incremental progress updates", async () => {
	const dialog = new StubOAuthDialog();
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	callbacks.onProgress?.("Waiting for device confirmation...");
	callbacks.onProgress?.("Still waiting for approval...");
	callbacks.onProgress?.("Refreshing tokens...");

	assert.deepEqual(dialog.waitingMessages, ["Waiting for device confirmation..."]);
	assert.deepEqual(dialog.progressMessages, [
		"Still waiting for approval...",
		"Refreshing tokens...",
	]);
});

test("OAuth dialog bridge validates required prompt input with a clear message", async () => {
	const dialog = new StubOAuthDialog();
	dialog.promptResult = "   ";
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	await assert.rejects(
		() => callbacks.onPrompt({ message: "Enter one-time code" }),
		/OAuth input is required to continue login\./,
	);
	assert.deepEqual(dialog.promptCalls, [{ message: "Enter one-time code", placeholder: undefined }]);
});

test("OAuth dialog bridge accepts optional empty prompt input", async () => {
	const dialog = new StubOAuthDialog();
	dialog.promptResult = "   ";
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	const value = await callbacks.onPrompt({
		message: "Optional note",
		allowEmpty: true,
	});

	assert.equal(value, "   ");
});

test("OAuth dialog bridge uses the pi-mono manual code prompt and validates empty input", async () => {
	const dialog = new StubOAuthDialog();
	dialog.manualInputResult = "";
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	await assert.rejects(
		() => callbacks.onManualCodeInput?.() ?? Promise.resolve(""),
		/Authorization code or callback URL is required to continue login\./,
	);
	assert.deepEqual(dialog.manualInputCalls, [MANUAL_CODE_INPUT_PROMPT]);
});

test("OAuth success messages report the storage slot and credential totals", () => {
	assert.equal(
		formatOAuthLoginSuccessMessage("github-copilot", {
			credentialId: "github-copilot-2",
			isBackupCredential: true,
			credentialIds: ["github-copilot", "github-copilot-2"],
		}),
		"OAuth login successful for github-copilot. Stored as backup credential github-copilot-2. Total credentials: 2",
	);
	assert.equal(
		formatOAuthLoginSuccessMessage("openai-codex", {
			credentialId: "openai-codex",
			isBackupCredential: false,
			credentialIds: ["openai-codex"],
		}),
		"OAuth login successful for openai-codex. Stored as primary credential openai-codex. Total credentials: 1",
	);
});

// ---------------------------------------------------------------------------
// onDeviceCode callback
// ---------------------------------------------------------------------------

test("OAuth dialog bridge onDeviceCode shows verification URI and user code", () => {
	const dialog = new StubOAuthDialog();
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	const deviceCodeInfo: OAuthDeviceCodeInfo = {
		userCode: "ABCD-1234",
		verificationUri: "https://example.com/device",
		intervalSeconds: 5,
		expiresInSeconds: 600,
	};
	callbacks.onDeviceCode(deviceCodeInfo);

	assert.equal(dialog.authCalls.length, 1);
	assert.equal(dialog.authCalls[0].url, "https://example.com/device");
	assert.match(dialog.authCalls[0].instructions ?? "", /Enter code: ABCD-1234/);
});

test("OAuth dialog bridge onDeviceCode resets waiting state", () => {
	const dialog = new StubOAuthDialog();
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	// Show waiting first
	callbacks.onProgress?.("Waiting for device confirmation...");
	assert.equal(dialog.waitingMessages.length, 1);

	// Device code arrives → waiting state should reset to progress
	callbacks.onDeviceCode({
		userCode: "CODE",
		verificationUri: "https://example.com/device",
		intervalSeconds: 5,
		expiresInSeconds: 600,
	});

	// After onDeviceCode reset, next progress should be a new waiting message
	callbacks.onProgress?.("Polling for approval...");
	assert.equal(dialog.waitingMessages.length, 2); // first waiting + new waiting after reset
	assert.equal(dialog.progressMessages.length, 0);
});

test("OAuth dialog bridge onDeviceCode handles minimal device code info", () => {
	const dialog = new StubOAuthDialog();
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	// Minimal info without verificationUriComplete
	callbacks.onDeviceCode({
		userCode: "MINI",
		verificationUri: "https://example.com/device",
	});

	assert.equal(dialog.authCalls.length, 1);
	assert.equal(dialog.authCalls[0].url, "https://example.com/device");
});

test("OAuth dialog bridge onDeviceCode shows auth directly without prior waiting state", () => {
	const dialog = new StubOAuthDialog();
	const callbacks = new OAuthDialogCallbackBridge(dialog).createCallbacks();

	callbacks.onDeviceCode({
		userCode: "FIRST",
		verificationUri: "https://example.com/device",
	});

	assert.equal(dialog.authCalls.length, 1);
	// No waiting message was shown before device code
	assert.equal(dialog.waitingMessages.length, 0);
});

// ---------------------------------------------------------------------------
// formatOAuthLoginSuccessMessage edge cases
// ---------------------------------------------------------------------------

test("formatOAuthLoginSuccessMessage handles single credential", () => {
	const msg = formatOAuthLoginSuccessMessage("test-provider", {
		credentialId: "test-provider",
		isBackupCredential: false,
		credentialIds: ["test-provider"],
	});
	assert.equal(msg, "OAuth login successful for test-provider. Stored as primary credential test-provider. Total credentials: 1");
});

test("formatOAuthLoginSuccessMessage handles empty credentialIds", () => {
	const msg = formatOAuthLoginSuccessMessage("empty", {
		credentialId: "empty",
		isBackupCredential: false,
		credentialIds: [],
	});
	assert.equal(msg, "OAuth login successful for empty. Stored as primary credential empty. Total credentials: 0");
});
