import type { ApiError } from "@/lib/core/ipc";

type BridgeRecoveryKey =
	| "errors.bridgeIdentityLocked"
	| "errors.bridgeIdentityUnavailable"
	| "errors.bridgeIdentityInvalid"
	| "errors.bridgeIdentityMissing"
	| "errors.bridgeIdentityCleanup";

/** Native identity failures keep their distinct recovery action in the UI. */
export function bridgeRecoveryKey(error: unknown): BridgeRecoveryKey | null {
	const code = (error as ApiError | null)?.code;
	switch (code) {
		case "bridge_identity_locked":
			return "errors.bridgeIdentityLocked";
		case "bridge_identity_unavailable":
			return "errors.bridgeIdentityUnavailable";
		case "bridge_identity_invalid":
			return "errors.bridgeIdentityInvalid";
		case "bridge_identity_missing":
			return "errors.bridgeIdentityMissing";
		case "bridge_identity_cleanup_pending":
			return "errors.bridgeIdentityCleanup";
		default:
			return null;
	}
}

export function canResetBridgeIdentity(error: unknown): boolean {
	return [
		"bridge_identity_invalid",
		"bridge_identity_missing",
		"bridge_identity_cleanup_pending",
	].includes((error as ApiError | null)?.code ?? "");
}
