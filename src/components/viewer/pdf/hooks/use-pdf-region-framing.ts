/**
 * Region framing (⌘. marquee) and the crop that turns a framed region into a
 * draft card.
 *
 * Split from {@link usePdfVisualMarks} because it is a different lifecycle: an
 * armed input mode plus one in-flight PDFium crop, with no knowledge of marks,
 * agents or persistence. It produces a draft and hands it to
 * {@link usePdfVisualDraft}, which owns the draft state.
 */

import type { PdfEngine } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { useInteractionManagerCapability } from "@embedpdf/plugin-interaction-manager/react";
import type { useSelectionCapability } from "@embedpdf/plugin-selection/react";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { isPdfDocumentCloseRaceError } from "@/components/viewer/pdf/host-dom";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import type {
	PdfRegionPromptDraft,
	ScreenPoint,
	SelectionMenuState,
	VisualDraftEditorState,
} from "@/components/viewer/pdf/types";
import { notifyError } from "@/lib/core/notify";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { normalizedRegionFromPoints } from "@/lib/pdf/region";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

type SelectionCapabilityProvides = ReturnType<
	typeof useSelectionCapability
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
	selectionCap: SelectionCapabilityProvides;
	interactionCap: InteractionManagerCapability;
	/** Text-selection cluster: framing a region dismisses an open menu. */
	setSelectionMenu: Dispatch<SetStateAction<SelectionMenuState | null>>;
	/**
	 * Draft completion callback: persist the crop as a note-only visual mark and
	 * open it in the right-rail comment editor (#396).
	 */
	onVisualDraft: (draft: VisualDraftEditorState) => void;
	/** Unsent crop for a parent-owned review/composer; never creates a mark. */
	onRegionPrompt?: (draft: PdfRegionPromptDraft) => void;
	/** Screen anchor beside a page-normalized region (draft card placement). */
	screenPointForRegion: (
		pageIndex0: number,
		region: PdfAskNormalizedRect,
	) => ScreenPoint;
	/** True for PDFs outside papers/ (plain viewer): no visual annotation. */
	plainViewer?: boolean;
};

export type PdfRegionFraming = {
	/** Region framing (marquee) mode is armed. */
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
	/** Crop a region and open the draft editor (does not send). */
	beginVisualAnnotation: (
		page: number,
		region: PdfAskNormalizedRect,
	) => Promise<void>;
	/** Crop a lasso region into an unsent context draft, without the mark flow. */
	beginRegionPrompt: (
		page: number,
		region: PdfAskNormalizedRect,
	) => Promise<void>;
	/** Marquee release on a page → crop that region. */
	handleVisualRegionSelect: (
		page: number,
		region: PdfAskNormalizedRect,
	) => void;
};

export function usePdfRegionFraming({
	docId,
	engine,
	docCap,
	selectionCap,
	interactionCap,
	setSelectionMenu,
	onVisualDraft,
	onRegionPrompt,
	screenPointForRegion,
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
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		setRegionSelecting((active) => !active);
	}, [plainViewer, selectionCap, docId, setSelectionMenu]);

	/** Shared source-PDF crop pipeline; the destination owns review/persistence. */
	const beginCrop = useCallback(
		async (
			page: number,
			input: PdfAskNormalizedRect,
			kind: "visual" | "prompt",
		) => {
			if (
				plainViewer ||
				!engine ||
				!docCap ||
				visualCropPendingRef.current ||
				(kind === "prompt" && !onRegionPrompt)
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
				setSelectionMenu(null);
				selectionCap?.clear(docId);
				const image = await renderPdfRegionPromptImage({
					engine,
					document,
					pageIndex: page - 1,
					region,
				});
				if (!isCurrent()) return;
				if (kind === "prompt") onRegionPrompt?.({ page, region, image });
				else
					onVisualDraft({
						screen: screenPointForRegion(page - 1, region),
						page,
						region,
						image,
					});
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
			onVisualDraft,
			screenPointForRegion,
			setSelectionMenu,
			selectionCap,
		],
	);
	const beginVisualAnnotation = useCallback(
		(page: number, region: PdfAskNormalizedRect) =>
			beginCrop(page, region, "visual"),
		[beginCrop],
	);
	const beginRegionPrompt = useCallback(
		(page: number, region: PdfAskNormalizedRect) =>
			beginCrop(page, region, "prompt"),
		[beginCrop],
	);

	const handleVisualRegionSelect = useCallback(
		(page: number, region: PdfAskNormalizedRect) => {
			void beginVisualAnnotation(page, region);
		},
		[beginVisualAnnotation],
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
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		const scope = interactionCap?.forDocument(docId);
		scope?.pause();
		return () => {
			scope?.resume();
		};
	}, [regionSelecting, selectionCap, interactionCap, docId, setSelectionMenu]);

	return {
		regionSelecting,
		visualCropPending,
		visualCropRegion,
		toggleRegionSelect,
		beginVisualAnnotation,
		beginRegionPrompt,
		handleVisualRegionSelect,
	};
}
