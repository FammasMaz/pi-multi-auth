import { MultiAuthStorage } from "./storage.js";

export interface MultiAuthHiddenProvidersOptions {
	storagePath?: string;
}

/**
 * Reads the pi-multi-auth UI hidden-provider state through the supported storage boundary.
 */
export async function readMultiAuthHiddenProviders(options: MultiAuthHiddenProvidersOptions = {}): Promise<string[]> {
	const storage = options.storagePath === undefined
		? new MultiAuthStorage()
		: new MultiAuthStorage(options.storagePath);
	const state = await storage.read();
	return [...state.ui.hiddenProviders];
}
