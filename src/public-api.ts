import { loadMultiAuthConfig } from "./config.js";

export interface MultiAuthHiddenProvidersOptions {
	configPath?: string;
}

/**
 * Reads the pi-multi-auth hidden-provider state through the supported config boundary.
 */
export async function readMultiAuthHiddenProviders(options: MultiAuthHiddenProvidersOptions = {}): Promise<string[]> {
	return [...loadMultiAuthConfig(options.configPath).config.hiddenProviders];
}
