import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import {
	type MobileRouteSnapshot,
	type MobileWindowRoute,
	readMobileRoute,
	saveMobileRoute,
	snapshotMobileRoute,
} from "@/lib/mobile/route";

export type UseMobileRouteOptions = {
	vaultPath: string | null;
	loading: boolean;
	route: MobileWindowRoute;
	onRestore: (route: MobileWindowRoute) => void;
};
type Owner = {
	vault: string;
	active: boolean;
	interacted: boolean;
	applied: boolean;
	ready: boolean;
	stopped: boolean;
	read: MobileRouteSnapshot | null;
	accept: (route: MobileWindowRoute, flush?: boolean) => void;
	fail: (kind: "restoreFailed" | "saveFailed", error: unknown) => void;
};

export function useMobileRoute(options: UseMobileRouteOptions): {
	markInteraction: () => void;
} {
	const { vaultPath, loading, route } = options;
	const { t } = useTranslation("mobile");
	const latest = useRef(options);
	latest.current = options;
	const translate = useRef(t);
	translate.current = t;
	const owner = useRef<Owner | null>(null);
	const intent = useRef<{ vault: string | null; touched: boolean }>({
		vault: null,
		touched: false,
	});
	// The chain owns every admitted RPC even after a vault changes or the hook unmounts.
	const rpc = useRef<Promise<void>>(Promise.resolve());
	const [loaded, setLoaded] = useState<Owner | null>(null);
	const [ready, setReady] = useState<Owner | null>(null);
	const markInteraction = useCallback(() => {
		intent.current = { vault: latest.current.vaultPath, touched: true };
		if (owner.current?.vault === latest.current.vaultPath)
			owner.current.interacted = true;
	}, []);
	useEffect(() => {
		if (!vaultPath || !isTauri()) return;
		const inherited =
			intent.current.touched &&
			(intent.current.vault === null || intent.current.vault === vaultPath);
		intent.current = { vault: vaultPath, touched: inherited };
		let timer: ReturnType<typeof setTimeout> | null = null;
		let revision = "";
		let persisted = "";
		let seen = "";
		let pending: MobileWindowRoute | null = null;
		let writing = false;
		let due = 0;
		let flush = false;
		const current = () =>
			state.active &&
			owner.current === state &&
			latest.current.vaultPath === vaultPath;
		const cancelTimer = () => {
			if (timer !== null) clearTimeout(timer);
			timer = null;
		};
		const state: Owner = {
			vault: vaultPath,
			active: true,
			interacted: inherited,
			applied: false,
			ready: false,
			stopped: false,
			read: null,
			fail(kind, error) {
				if (!current() || state.stopped) return;
				state.stopped = true;
				pending = null;
				cancelTimer();
				notifyError(translate.current(`route.${kind}`), {
					description: errorText(error),
				});
			},
			accept(next, immediate = false) {
				if (!current() || !state.ready || state.stopped) return;
				const captured = snapshotMobileRoute(next);
				const key = JSON.stringify(captured);
				if (key !== seen) {
					seen = key;
					pending = key === persisted && !writing ? null : captured;
					due = Date.now() + 400;
				}
				if (immediate) flush = Boolean(pending);
				if (!pending) flush = false;
				arm();
			},
		};
		function arm() {
			cancelTimer();
			if (!current() || state.stopped || !pending || writing) return;
			const delay = flush ? 0 : Math.max(0, due - Date.now());
			if (delay > 0) {
				timer = setTimeout(arm, delay);
				return;
			}
			writing = true;
			rpc.current = rpc.current.then(async () => {
				if (!current() || state.stopped || !pending) {
					writing = false;
					return;
				}
				if (JSON.stringify(pending) === persisted) {
					pending = null;
					writing = false;
					return;
				}
				const captured = pending;
				pending = null;
				flush = false;
				try {
					const result = await saveMobileRoute(state.vault, revision, captured);
					if (!current()) return;
					if (!result.route)
						throw new Error("The native route save returned no route");
					revision = result.revision;
					persisted = JSON.stringify(snapshotMobileRoute(result.route));
				} catch (error) {
					state.fail("saveFailed", error);
				} finally {
					writing = false;
					if (current()) {
						if (pending && JSON.stringify(pending) === persisted)
							pending = null;
						arm();
					}
				}
			});
		}
		owner.current = state;
		rpc.current = rpc.current.then(async () => {
			if (!current()) return;
			try {
				const result = await readMobileRoute(vaultPath);
				if (!current()) return;
				revision = result.revision;
				persisted = result.route
					? JSON.stringify(snapshotMobileRoute(result.route))
					: "null";
				state.read = result;
				setLoaded(state);
			} catch (error) {
				state.fail("restoreFailed", error);
			}
		});
		const flushLatest = () => {
			if (!current() || latest.current.loading) return;
			state.accept(latest.current.route, true);
		};
		const hidden = () => {
			if (document.visibilityState === "hidden") flushLatest();
		};
		window.addEventListener("pagehide", flushLatest);
		document.addEventListener("visibilitychange", hidden);
		return () => {
			state.active = false;
			cancelTimer();
			window.removeEventListener("pagehide", flushLatest);
			document.removeEventListener("visibilitychange", hidden);
		};
	}, [vaultPath]);
	useEffect(() => {
		if (
			!loaded ||
			loaded !== owner.current ||
			!loaded.active ||
			loaded.vault !== vaultPath ||
			loading ||
			loaded.stopped ||
			loaded.applied ||
			!loaded.read
		)
			return;
		loaded.applied = true;
		try {
			if (!loaded.interacted && loaded.read.route)
				latest.current.onRestore(snapshotMobileRoute(loaded.read.route));
			// Parent route updates from onRestore and this ready state commit together.
			setReady(loaded);
		} catch (error) {
			loaded.fail("restoreFailed", error);
		}
	}, [loaded, loading, vaultPath]);
	useEffect(() => {
		if (
			!ready ||
			ready !== owner.current ||
			!ready.active ||
			ready.vault !== vaultPath ||
			loading ||
			ready.stopped
		)
			return;
		ready.ready = true;
		ready.accept(route);
	}, [ready, route, loading, vaultPath]);
	return { markInteraction };
}
