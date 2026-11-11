import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type BridgeClientStatus,
	bridgeDisconnect,
	bridgeResume,
	bridgeStatus,
	listenBridgeStatus,
	listenPairPending,
	type PairPendingEvent,
} from "@/lib/bridge/client";
import {
	bridgeRecoveryKey,
	canResetBridgeIdentity,
} from "@/lib/bridge/recovery";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";

/** Read public saved metadata in any mode; open credentials only for selected Bridge. */
export function useBridgeStatus(enabled = true) {
	const { t } = useTranslation("mobile");
	const translate = useRef(t);
	translate.current = t;
	const [status, updateStatus] = useState<BridgeClientStatus>({
		connected: false,
		paired: false,
	});
	const [pairPending, setPairPending] = useState<PairPendingEvent | null>(null);
	const [resetAvailable, setResetAvailable] = useState(false);
	const epoch = useRef(0);
	const events = useRef(0);
	const paused = useRef(false);
	const inFlight = useRef<Promise<void> | null>(null);
	const alive = useRef(false);
	const selected = useRef(enabled);
	selected.current = enabled;
	const lastError = useRef<string | null>(null);

	const report = useCallback((error: unknown) => {
		setResetAvailable(canResetBridgeIdentity(error));
		const key = bridgeRecoveryKey(error);
		const message = key ? translate.current(key) : errorText(error);
		if (lastError.current !== message) notifyError(message);
		lastError.current = message;
	}, []);
	const setStatus = useCallback((next: BridgeClientStatus) => {
		epoch.current++;
		updateStatus(next);
		setResetAvailable(false);
		lastError.current = null;
		if (!next.paired) setPairPending(null);
	}, []);
	const resume = useCallback((): Promise<void> => {
		if (inFlight.current) return inFlight.current;
		if (!isTauri() || !alive.current || !selected.current)
			return Promise.resolve();
		paused.current = false;
		const generation = epoch.current;
		const observed = events.current;
		const current = () =>
			alive.current &&
			selected.current &&
			!paused.current &&
			epoch.current === generation;
		const attempt = (async () => {
			try {
				const next = await bridgeResume();
				if (current()) {
					if (events.current === observed) updateStatus(next);
					lastError.current = null;
					setResetAvailable(false);
				}
			} catch (error) {
				if (!current()) return;
				report(error);
				try {
					const next = await bridgeStatus();
					if (current() && events.current === observed) updateStatus(next);
				} catch {
					/* Retain the last public pairing metadata. */
				}
			}
		})().finally(() => {
			if (inFlight.current === attempt) inFlight.current = null;
		});
		inFlight.current = attempt;
		return attempt;
	}, [report]);
	const disconnect = useCallback(async () => {
		epoch.current++;
		paused.current = true;
		await bridgeDisconnect();
		const next = await bridgeStatus();
		if (alive.current) updateStatus(next);
	}, []);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			epoch.current++;
		};
	}, []);
	useEffect(() => {
		if (!isTauri()) return;
		let active = true;
		const generation = ++epoch.current;
		paused.current = false;
		const unlisten: Array<() => void> = [];
		const current = () => active && epoch.current === generation;
		void (async () => {
			const subscriptions = await Promise.allSettled([
				listenBridgeStatus((next) => {
					if (!active) return;
					events.current++;
					updateStatus(next);
					if (next.connected) {
						lastError.current = null;
						setResetAvailable(false);
					}
				}),
				listenPairPending((next) => {
					if (active && selected.current) setPairPending(next);
				}),
			]);
			for (const result of subscriptions) {
				if (result.status === "fulfilled") {
					if (active) unlisten.push(result.value);
					else result.value();
				} else if (active && enabled) report(result.reason);
			}
			if (!current()) return;
			const observed = events.current;
			try {
				const next = await bridgeStatus();
				if (current() && events.current === observed) updateStatus(next);
			} catch (error) {
				if (current() && enabled) report(error);
			}
			if (current() && enabled) await resume();
		})();
		const onVisible = () => {
			if (
				!active ||
				!enabled ||
				paused.current ||
				document.visibilityState !== "visible"
			)
				return;
			void resume();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			active = false;
			epoch.current++;
			inFlight.current = null;
			document.removeEventListener("visibilitychange", onVisible);
			for (const off of unlisten) off();
			if (enabled) void bridgeDisconnect().catch(() => undefined);
		};
	}, [enabled, report, resume]);
	return { status, setStatus, pairPending, disconnect, resume, resetAvailable };
}
