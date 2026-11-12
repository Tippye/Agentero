import { type BackgroundState, commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

export type { BackgroundState } from "@/lib/core/bindings";

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
