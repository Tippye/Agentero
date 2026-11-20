import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { PdfViewerProps } from "@/components/viewer/pdf/types";
import { notifyError } from "@/lib/core/notify";
import { InkController, type InkOverview } from "@/lib/pdf/ink/controller";
import { InkEditor } from "@/lib/pdf/ink/editor";
import { applyPdfInk, readPdfInk } from "@/lib/pdf/ink-api";
import { listenVaultFileChangedGated } from "@/lib/vault/file-change-gate";

// Dirty controllers survive PDF engine/provider remounts in this webview;
// re-registering new PDF bytes must not discard a retained failed native edit.
const retained = new Map<
	string,
	{ controller: InkController; readers: number }
>();
// Editable panes (original + translated companion) share one InkEditor per
// paper so the single original toolbar also controls ink on the translated
// page. Read-only embeds never join this map.
const sharedEditors = new Map<string, InkEditor>();

const IDLE: InkOverview = {
	dirty: false,
	saving: false,
	failedPage: null,
	conflict: false,
	canUndo: false,
	canRedo: false,
};
const idle = () => IDLE;
const noopSubscribe = () => () => {};

export function usePdfInk({
	vaultPath,
	paperRelPath,
	enabled,
	editable,
	isActive,
	sharedEditor = false,
	controlsMode = true,
	onInkDirtyChange,
	onInkModeChange,
}: Pick<
	PdfViewerProps,
	"vaultPath" | "paperRelPath" | "onInkDirtyChange" | "onInkModeChange"
> & {
	enabled: boolean;
	editable: boolean;
	isActive: boolean;
	/** Reuse one tool/selection state for both panes of the same paper. */
	sharedEditor?: boolean;
	/** A shared editor is driven by the toolbar owner; panes must not reset it. */
	controlsMode?: boolean;
}) {
	const { t } = useTranslation("viewer");
	const folder = paperRelPath?.replace(/\\/g, "/");
	const key =
		enabled &&
		vaultPath &&
		folder &&
		/^papers\/[^/]+$/.test(folder) &&
		!/^(remote|bridge):/.test(vaultPath)
			? `${vaultPath}\u0000${folder}`
			: null;
	const editor = useMemo(() => {
		if (!key || !vaultPath || !folder) return null;
		let value = retained.get(key);
		if (!value) {
			const controller = new InkController({
				read: (page) => readPdfInk({ vaultPath, paperFolder: folder, page }),
				apply: (page, expectedRevision, operations) =>
					applyPdfInk({
						vaultPath,
						paperFolder: folder,
						page,
						expectedRevision,
						operations,
					}),
			});
			value = { controller, readers: 0 };
			retained.set(key, value);
		}
		// Persistence is shared per paper; tool/selection state belongs to this
		// viewer so a read-only note embed cannot disarm the active reader's pen.
		// Editable panes explicitly opt into one shared editor so the original
		// toolbar is the only toolbar and drives ink on both documents.
		if (sharedEditor && key) {
			let shared = sharedEditors.get(key);
			if (!shared) {
				shared = new InkEditor(value.controller);
				sharedEditors.set(key, shared);
			}
			return shared;
		}
		return new InkEditor(value.controller);
	}, [key, vaultPath, folder, sharedEditor]);
	const overview = useSyncExternalStore(
		editor?.controller.subscribe ?? noopSubscribe,
		editor?.controller.getOverview ?? idle,
		idle,
	);
	const mode = useSyncExternalStore(
		editor?.subscribe ?? noopSubscribe,
		() => editor?.getState().mode ?? "read",
		() => "read",
	);
	const callbacks = useRef({ onInkDirtyChange, onInkModeChange });
	callbacks.current = { onInkDirtyChange, onInkModeChange };
	useEffect(() => {
		if (!editor) {
			callbacks.current.onInkDirtyChange?.(false);
			return;
		}
		let previous: boolean | undefined;
		const report = () => {
			const dirty = editor.controller.getOverview().dirty;
			if (dirty !== previous) {
				previous = dirty;
				callbacks.current.onInkDirtyChange?.(dirty);
			}
		};
		report();
		// Native pointer listeners report synchronously, before a second pointer
		// or a keyboard navigation action can ask the parent to leave.
		return editor.controller.subscribe(report);
	}, [editor]);
	useEffect(() => {
		let previous: boolean | undefined;
		const report = () => {
			const active =
				editable &&
				isActive &&
				editor !== null &&
				editor.getState().mode !== "read";
			if (active !== previous) {
				previous = active;
				callbacks.current.onInkModeChange?.(active);
			}
		};
		report();
		return editor?.subscribe(report);
	}, [editor, editable, isActive]);
	useEffect(() => {
		if (!controlsMode || !editable || !isActive) return;
		editor?.setMode("read");
	}, [editable, isActive, editor, controlsMode]);
	useEffect(() => {
		let entry = key ? retained.get(key) : undefined;
		if (!entry && key && editor) {
			entry = { controller: editor.controller, readers: 0 };
			retained.set(key, entry);
		}
		if (entry) entry.readers++;
		return () => {
			editor?.cancel();
			callbacks.current.onInkModeChange?.(false);
			if (entry) entry.readers--;
			if (key && entry?.readers === 0) {
				if (!entry.controller.getOverview().dirty) retained.delete(key);
				sharedEditors.delete(key);
			}
		};
	}, [key, editor]);
	useEffect(() => {
		if (!editor || !isActive) return;
		return listenVaultFileChangedGated((event) => {
			const marker = `${folder}/marks/ink/`.toLowerCase();
			for (const path of event.paths) {
				const normalized = path.replace(/\\/g, "/").toLowerCase();
				const offset = normalized.lastIndexOf(marker);
				if (offset < 0 || (offset > 0 && normalized[offset - 1] !== "/"))
					continue;
				const match = /^p(\d+)\.json$/.exec(
					normalized.slice(offset + marker.length),
				);
				if (match) void editor.controller.load(Number(match[1]), true);
			}
		});
	}, [editor, isActive, folder]);
	const lastError = useRef<unknown>(null);
	useEffect(() => {
		const error =
			overview.failedPage === null
				? null
				: editor?.controller.getPage(overview.failedPage).error;
		if (!error || lastError.current === error) return;
		lastError.current = error;
		notifyError(t(overview.conflict ? "ink.conflict" : "ink.saveFailed"));
	}, [editor, overview, t]);
	return { editor, overview, mode };
}
