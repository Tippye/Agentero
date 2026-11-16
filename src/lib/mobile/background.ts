import { type BackgroundState, commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

import { isTauri } from "@/lib/core/tauri";

export type { BackgroundState } from "@/lib/core/bindings";

/** Host-confirmed transfer lease for a WebView-owned run. */
export type BackgroundTransferLease = {
	leaseId: number | null;
	hiddenAllowed: boolean;
};

export function getMobileBackgroundState(): Promise<BackgroundState> {
	return callApiResult(() => commands.mobileBackgroundGetState());
}
export function configureMobileBackground(
	enabled: boolean,
): Promise<BackgroundState> {
	return callApiResult(() => commands.mobileBackgroundConfigure(enabled));
}
export function requestMobileBackgroundNotifications(): Promise<BackgroundState> {
	return callApiResult(() => commands.mobileBackgroundRequestNotifications());
}
export function openMobileBackgroundSettings(
	target: "battery" | "notifications" | "app",
): Promise<BackgroundState> {
	return callApiResult(() => commands.mobileBackgroundOpenSettings(target));
}

/**
 * Ask the Host to carry this run with an OS transfer lease. Returns null when
 * the platform cannot (or the lease could not be admitted); the caller then
 * keeps the normal foreground-only behavior instead of failing the run.
 */
export async function beginBackgroundTransfer(): Promise<BackgroundTransferLease | null> {
	if (!isTauri()) return null;
	try {
		return await callApiResult(() => commands.mobileBackgroundBeginTransfer());
	} catch {
		return null;
	}
}

/** Release a lease; a late or duplicated release must not fail the run. */
export async function endBackgroundTransfer(leaseId: number): Promise<void> {
	if (!isTauri()) return;
	try {
		await callApiResult(() =>
			commands.mobileBackgroundEndTransfer({ leaseId }),
		);
	} catch {
		// The native window may already be gone; the Host drops stale leases.
	}
}
