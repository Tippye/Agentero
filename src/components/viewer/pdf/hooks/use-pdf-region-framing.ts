/**
 * Region framing (⌘. marquee / mobile lasso) and the crop that turns a framed
 * region into a draft.
 *
 * Split from {@link usePdfVisualMarks} because it is a different lifecycle: an
 * armed input mode plus one in-flight PDFium crop, with no knowledge of marks,
 * agents or persistence. A framed region has exactly one destination: the
 * unsent region-prompt draft handed to the parent (`onRegionPrompt`). Notes and
 * visual marks are never created from a drawn region — they are added from a
 * text selection or the layout element tool card.
 */

import type { PdfEngine } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { useInteractionManagerCapability } from "@embedpdf/plugin-interaction-manager/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isPdfDocumentCloseRaceError } from "@/components/viewer/pdf/host-dom";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import type { PdfRegionPromptDraft } from "@/components/viewer/pdf/types";
import { notifyError } from "@/lib/core/notify";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { normalizedRegionFromPoints } from "@/lib/pdf/region";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

type InteractionManagerCapability = ReturnType<
	typeof useInteractionManagerCapability
>["provides"];

export type UsePdfRegionFramingOptions = {
	docId: string;
	/** Shared PDFium engine (null until the WASM host finished booting). */
	engine: PdfEngine | null;
	/** EmbedPDF capabilities; owned by `PdfViewerInner` (plugin context). */
	docCap: DocumentManagerCapability;
	interactionCap?: InteractionManagerCapability;
	/** Unsent crop for a parent-owned review/composer; never creates a mark. */
	onRegionPrompt?: (draft: PdfRegionPromptDraft) => void;
	/** True for PDFs outside papers/ (plain viewer): no region framing. */
	plainViewer?: boolean;
};

export type PdfRegionFraming = {
	/** Region framing (marquee / mobile lasso) mode is armed. */
	regionSelecting: boolean;
	/** A crop is in flight; blocks re-entry. */
	visualCropPending: boolean;
	/**
	 * Region whose crop is in flight (null when idle). Rendered on the page so a
	 * click has a visible response before the draft card opens.
	 */
	visualCropRegion: { page: number; region: PdfAskNormalizedRect } | null;
	/** Enter / leave region framing. Shared by the toolbar and the handle (⌘.). */
	toggleRegionSelect: () => void;
	/** Crop a lasso region into an unsent context draft, without the mark flow. */
	beginRegionPrompt: (
		page: number,
		region: PdfAskNormalizedRect,
	) => Promise<void>;
};

export function usePdfRegionFraming({
	docId,
	engine,
	docCap,
	interactionCap,
	onRegionPrompt,
	plainViewer = false,
}: UsePdfRegionFramingOptions): PdfRegionFraming {
	const { t } = useTranslation("viewer");
	const [regionSelecting, setRegionSelecting] = useState(false);
	const [visualCropPending, setVisualCropPending] = useState(false);
	const [visualCropRegion, setVisualCropRegion] = useState<{
		page: number;
		region: PdfAskNormalizedRect;
	} | null>(null);
	/** Synchronous guard: a second click can arrive before React commits busy UI. */
	const visualCropPendingRef = useRef(false);
	const activeRequest = useRef<object | null>(null);
	const currentDocument = useRef({ docId, engine });
	currentDocument.current = { docId, engine };
	useEffect(() => {
		void docId;
		void engine;
		setRegionSelecting(false);
		setVisualCropPending(false);
		setVisualCropRegion(null);
		visualCropPendingRef.current = false;
		return () => {
			activeRequest.current = null;
			visualCropPendingRef.current = false;
		};
	}, [docId, engine]);

	/** Enter/leave region framing. Shared by the toolbar and the handle. */
	const toggleRegionSelect = useCallback(() => {
		if (plainViewer || visualCropPendingRef.current) return;
		setRegionSelecting((active) => !active);
	}, [plainViewer]);

	/** Shared source-PDF crop pipeline; the parent owns review/persistence. */
	const beginRegionPrompt = useCallback(
		async (page: number, input: PdfAskNormalizedRect) => {
			if (
				plainViewer ||
				!engine ||
				!docCap ||
				visualCropPendingRef.current ||
				!onRegionPrompt
			)
				return;
			if (
				!Number.isSafeInteger(page) ||
				page < 1 ||
				![input.x, input.y, input.w, input.h].every(Number.isFinite) ||
				input.w <= 0 ||
				input.h <= 0
			)
				return;
			const region = normalizedRegionFromPoints(
				{ x: input.x, y: input.y },
				{ x: input.x + input.w, y: input.y + input.h },
			);
			if (!region || !docCap.isDocumentOpen(docId)) return;
			const document = docCap.getDocument(docId);
			if (!document?.pages[page - 1]) {
				notifyError(t("pdfExplain.cropFailed"));
				return;
			}
			const request = {};
			activeRequest.current = request;
			visualCropPendingRef.current = true;
			const isCurrent = () =>
				activeRequest.current === request &&
				currentDocument.current.docId === docId &&
				currentDocument.current.engine === engine &&
				docCap.isDocumentOpen(docId) &&
				docCap.getDocument(docId) === document;
			setVisualCropPending(true);
			setVisualCropRegion({ page, region });
			setRegionSelecting(false);
			try {
				const image = await renderPdfRegionPromptImage({
					engine,
					document,
					pageIndex: page - 1,
					region,
				});
				if (!isCurrent()) return;
				onRegionPrompt({ page, region, image });
			} catch (error) {
				if (!isCurrent() || isPdfDocumentCloseRaceError(error)) return;
				const message =
					error instanceof Error ? error.message : t("pdfExplain.cropFailed");
				notifyError(t("pdfExplain.cropFailed"), { description: message });
			} finally {
				// An old document's completion must not release a newer crop's guard.
				if (activeRequest.current === request) {
					activeRequest.current = null;
					visualCropPendingRef.current = false;
					setVisualCropPending(false);
					setVisualCropRegion(null);
				}
			}
		},
		[
			plainViewer,
			engine,
			docCap,
			docId,
			t,
			onRegionPrompt,
		],
	);

	useEffect(() => {
		if (!regionSelecting) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setRegionSelecting(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [regionSelecting]);

	// Region-select mode must not allow EmbedPDF text selection under the marquee.
	useEffect(() => {
		if (!regionSelecting) return;
		const scope = interactionCap?.forDocument(docId);
		scope?.pause();
		return () => {
			scope?.resume();
		};
	}, [regionSelecting, interactionCap, docId]);

	return {
		regionSelecting,
		visualCropPending,
		visualCropRegion,
		toggleRegionSelect,
		beginRegionPrompt,
	};
}
