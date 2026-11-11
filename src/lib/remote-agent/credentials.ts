import type {
	RemoteAgentCatalog,
	RemoteCredentialState,
} from "@/lib/core/bindings";

/** A failed native read is never equivalent to an empty store or permission to replace it. */
export function canSignIn(catalog: RemoteAgentCatalog | null): boolean {
	return (
		catalog !== null &&
		catalog.account === null &&
		(catalog.persistence === "launchOnly" ||
			catalog.credentialState === "missing")
	);
}
export function canRetrySavedSignIn(state: RemoteCredentialState): boolean {
	return (
		state === "locked" ||
		state === "unavailable" ||
		state === "connectionFailed"
	);
}
export function credentialMessageKey(state: RemoteCredentialState) {
	switch (state) {
		case "notChecked":
			return "remote.credentials.checking";
		case "locked":
			return "remote.credentials.locked";
		case "unavailable":
			return "remote.credentials.unavailable";
		case "invalid":
			return "remote.credentials.invalid";
		case "reauthenticationRequired":
			return "remote.credentials.reauthenticationRequired";
		case "connectionFailed":
			return "remote.credentials.connectionFailed";
		default:
			return null;
	}
}
