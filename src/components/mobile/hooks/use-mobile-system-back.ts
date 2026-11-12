import { onBackButtonPress } from "@tauri-apps/api/app";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { getMobileBackgroundState } from "@/lib/mobile/background";

export type UseMobileSystemBackOptions = {
	enabled: boolean;
	onBack: () => void;
};

/**
 * Own Android Back only while the caller has UI to dismiss or protect.
 * The public SDK consumes every press while a listener exists: return values
 * cannot delegate it. Registration/removal are asynchronous, so this hook does
 * not promise a physically atomic handoff or replay a press across that gap.
 * `false` unregisters the individual channel to restore the SDK's OS default.
 */
export function useMobileSystemBack({
	enabled,
	onBack,
}: UseMobileSystemBackOptions): boolean {
	const [android, setAndroid] = useState(false);
	const probe = useRef<Promise<boolean> | null>(null);
	const latest = useRef({ enabled, onBack });
	const transport = useRef({ tail: Promise.resolve(), stopped: false });
	useLayoutEffect(() => {
		latest.current = { enabled, onBack };
	}, [enabled, onBack]);

	useEffect(() => {
		let active = true;
		probe.current ??= Promise.resolve()
			.then(
				async () =>
					isTauri() &&
					(await getMobileBackgroundState()).platform === "android",
			)
			.catch((error) => {
				notifyError(errorText(error));
				return false;
			});
		void probe.current.then((value) => {
			if (active) setAndroid(value);
		});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (!android || !enabled) return;
		const state = transport.current;
		const lease: {
			active: boolean;
			listener: Awaited<ReturnType<typeof onBackButtonPress>> | null;
		} = { active: true, listener: null };
		const report = (error: unknown) => {
			notifyError(errorText(error));
		};
		const enqueue = (operation: () => Promise<void>) => {
			state.tail = state.tail.then(operation).catch(report);
		};
		enqueue(async () => {
			if (!lease.active || state.stopped) return;
			lease.listener = await onBackButtonPress(() => {
				if (!lease.active || !latest.current.enabled) return;
				try {
					void Promise.resolve(latest.current.onBack()).catch(report);
				} catch (error) {
					report(error);
				}
			});
		});
		return () => {
			lease.active = false;
			enqueue(async () => {
				if (!lease.listener) return;
				try {
					await lease.listener.unregister();
					lease.listener = null;
				} catch (error) {
					// A failed removal leaves native ownership unknown. Do not add a
					// second listener or silently retry an uncertain SDK operation.
					state.stopped = true;
					throw error;
				}
			});
		};
	}, [android, enabled]);
	return android;
}
