import { listen } from "@tauri-apps/api/event";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { takeAndImportOpenedMobilePdf } from "@/lib/mobile/import-pdf";

export type MobilePdfImportTarget = {
	mounted: boolean;
	vaultPath: string | null;
	epoch: number;
	refresh: () => Promise<void>;
};
type ExternalPdfOptions = {
	/** A committed local Vault returned by useMobileVault, never a remote handle. */
	vaultPath: string | null;
	admission: RefObject<boolean>;
	target: RefObject<MobilePdfImportTarget>;
	setImporting: (value: boolean) => void;
};
type IntakeOwner = { request: () => void; flush: () => void };

/** Wake-ups contain no URI or metadata. Rust claims and owns the entire intake.
 * Subscribe before the initial drain; coalesce busy/hidden wakes without polling.
 * The returned stable wake also releases pending intake after a manual import.
 */
export function useMobileExternalPdfs({
	vaultPath,
	admission,
	target,
	setImporting,
}: ExternalPdfOptions): () => void {
	const owner = useRef<IntakeOwner | null>(null);
	const wake = useCallback(() => owner.current?.request(), []);
	useEffect(() => {
		if (!isTauri() || !vaultPath?.trim()) return;
		const importingVault = vaultPath;
		const captured = target.current;
		if (!captured.mounted || captured.vaultPath !== importingVault) return;
		const epoch = captured.epoch;
		let active = true;
		let ready = false;
		let pending = false;
		let unlisten: (() => void) | undefined;
		const current = () =>
			active &&
			owner.current === state &&
			captured.mounted &&
			captured.vaultPath === importingVault &&
			captured.epoch === epoch;
		const state: IntakeOwner = {
			request() {
				if (!current()) return;
				pending = true;
				state.flush();
			},
			flush() {
				if (
					!current() ||
					!ready ||
					!pending ||
					document.visibilityState !== "visible" ||
					admission.current
				)
					return;
				pending = false;
				admission.current = true;
				setImporting(true);
				void drain();
			},
		};
		owner.current = state;
		async function drain() {
			let reported = false;
			const report = (error: unknown) => {
				if (current() && !reported) {
					reported = true;
					notifyError(errorText(error));
				}
			};
			try {
				const result = await takeAndImportOpenedMobilePdf(importingVault);
				if (result !== null && current()) {
					if (result.errors.length) report(result.errors.join("\n"));
					try {
						await captured.refresh();
					} catch (error) {
						report(error);
					}
				}
			} catch (error) {
				report(error);
				// Rust may have committed before its response failed. Observe the
				// current catalog once, without retrying or reclaiming the intake.
				if (current()) {
					try {
						await captured.refresh();
					} catch (refreshError) {
						report(refreshError);
					}
				}
			} finally {
				admission.current = false;
				if (current()) setImporting(false);
				// Do not create a new wake on completion (especially for null).
				// A new current Vault may already have one waiting on this admission.
				owner.current?.flush();
			}
		}
		const foreground = () => {
			if (document.visibilityState === "visible") state.request();
		};
		window.addEventListener("focus", foreground);
		document.addEventListener("visibilitychange", foreground);
		void listen<null>("mobile:external-pdf-pending", () => state.request())
			.then((off) => {
				if (!current()) {
					off();
					return;
				}
				unlisten = off;
				ready = true;
				state.request();
			})
			.catch((error) => {
				if (current()) notifyError(errorText(error));
			});
		return () => {
			active = false;
			pending = false;
			if (owner.current === state) owner.current = null;
			window.removeEventListener("focus", foreground);
			document.removeEventListener("visibilitychange", foreground);
			unlisten?.();
		};
	}, [vaultPath, admission, target, setImporting]);
	return wake;
}
