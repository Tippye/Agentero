import { useCallback, useEffect, useRef, useState } from "react";
import { events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { listPapers, rescanPapers } from "@/lib/paper/api";
import type { PaperMetadata } from "@/lib/paper/types";

/** Mobile has no filesystem watcher: rebuild on open and foreground, read the
 * local catalog on explicit refresh. Bridge connectivity is irrelevant. */
export function useMobilePapers({ vaultPath }: { vaultPath: string | null }) {
	const [papers, setPapers] = useState<PaperMetadata[]>([]);
	const [loading, setLoading] = useState(false);
	const generation = useRef(0);
	const pending = useRef<Promise<void> | null>(null);

	const refresh = useCallback(
		function refreshCatalog(rescan = false): Promise<void> {
			if (!vaultPath) return Promise.resolve();
			const current = generation.current;
			if (pending.current)
				return pending.current.then(() => {
					if (current !== generation.current) return;
					return refreshCatalog(rescan);
				});
			setLoading(true);
			const attempt = (async () => {
				try {
					if (rescan) await rescanPapers(vaultPath);
					const next = await listPapers(vaultPath);
					if (current === generation.current) setPapers(next);
				} catch (error) {
					if (current === generation.current) notifyError(errorText(error));
				} finally {
					if (current === generation.current) setLoading(false);
				}
			})();
			pending.current = attempt;
			void attempt.finally(() => {
				if (pending.current === attempt) pending.current = null;
			});
			return attempt;
		},
		[vaultPath],
	);

	useEffect(() => {
		generation.current += 1;
		pending.current = null;
		setPapers([]);
		if (!vaultPath) return;
		void refresh(true);
		const refreshWhenVisible = () => {
			if (document.visibilityState === "visible") void refresh(true);
		};
		window.addEventListener("focus", refreshWhenVisible);
		document.addEventListener("visibilitychange", refreshWhenVisible);
		return () => {
			generation.current += 1;
			window.removeEventListener("focus", refreshWhenVisible);
			document.removeEventListener("visibilitychange", refreshWhenVisible);
		};
	}, [vaultPath, refresh]);

	useEffect(() => {
		if (!vaultPath) return;
		let active = true;
		let dispose: (() => void) | undefined;
		void events.syncState
			.listen(({ payload }) => {
				if (
					active &&
					payload.vaultPath === vaultPath &&
					payload.status === "idle"
				)
					void refresh(true);
			})
			.then((off) => {
				if (active) dispose = off;
				else off();
			})
			.catch(() => undefined);
		return () => {
			active = false;
			dispose?.();
		};
	}, [vaultPath, refresh]);

	return { papers, loading, refresh };
}
