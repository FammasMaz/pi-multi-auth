import { KeyDistributor } from "./key-distributor.js";

let registeredDistributor: KeyDistributor | undefined;

/**
 * Registers a shared KeyDistributor instance for this extension module.
 */
export function registerGlobalKeyDistributor(distributor: KeyDistributor): KeyDistributor {
	registeredDistributor = distributor;
	return distributor;
}

/**
 * Clears the registered KeyDistributor instance.
 */
export function unregisterGlobalKeyDistributor(distributor?: KeyDistributor): void {
	if (
		distributor !== undefined &&
		registeredDistributor !== undefined &&
		registeredDistributor !== distributor
	) {
		return;
	}
	registeredDistributor = undefined;
}

/**
 * Returns the registered KeyDistributor instance for this extension module.
 */
export function getGlobalKeyDistributor(): KeyDistributor | null {
	return registeredDistributor ?? null;
}
