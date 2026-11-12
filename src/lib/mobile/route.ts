import {
	commands,
	type MobileRouteSnapshot,
	type MobileWindowRoute,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

export type {
	MobileRouteSnapshot,
	MobileWindowRoute,
} from "@/lib/core/bindings";

/** Snapshot only the reading route; never spread arbitrary application state into IPC. */
export function snapshotMobileRoute(
	route: MobileWindowRoute,
): MobileWindowRoute {
	return {
		paperId: route.paperId,
		tab: route.tab,
		readerMode: route.readerMode,
		preset: route.preset,
		pdf: route.pdf ? { page: route.pdf.page, zoom: route.pdf.zoom } : null,
	};
}
export function readMobileRoute(
	vaultPath: string,
): Promise<MobileRouteSnapshot> {
	return callApiResult(() => commands.mobileRouteRead(vaultPath));
}
export function saveMobileRoute(
	vaultPath: string,
	expectedRevision: string,
	route: MobileWindowRoute,
): Promise<MobileRouteSnapshot> {
	return callApiResult(() =>
		commands.mobileRouteSave(
			vaultPath,
			expectedRevision,
			snapshotMobileRoute(route),
		),
	);
}
