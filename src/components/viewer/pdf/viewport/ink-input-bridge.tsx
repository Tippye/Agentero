import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import {
	useViewportCapability,
	useViewportElement,
} from "@embedpdf/plugin-viewport/react";
import { useZoomCapability } from "@embedpdf/plugin-zoom/react";
import { type RefObject, useEffect } from "react";
import { pdfPageRenderRotation } from "@/components/viewer/pdf/layers/agentero-render-layer";
import type { InkEditor } from "@/lib/pdf/ink/editor";
import { bindInkInput } from "@/lib/pdf/ink/input";

/** Public viewport scrolling plus the enclosing ZoomGestureWrapper handle fingers. */
export function InkInputBridge({
	editor,
	documentId,
	enabled,
	docCapRef,
}: {
	editor: InkEditor | null;
	documentId: string;
	enabled: boolean;
	docCapRef: RefObject<
		ReturnType<typeof useDocumentManagerCapability>["provides"]
	>;
}) {
	const viewportRef = useViewportElement();
	const { provides: viewport } = useViewportCapability();
	const { provides: zoom } = useZoomCapability();
	useEffect(() => {
		const target = viewportRef?.current;
		if (!enabled || !editor || !target || !viewport) return;
		const binding = bindInkInput({
			target,
			editor,
			viewport: () => viewport.forDocument(documentId),
			pageAt: (eventTarget) => {
				const element =
					eventTarget instanceof Element
						? eventTarget.closest<HTMLElement>("[data-annotation-page]")
						: null;
				if (!element || element.dataset.annotationPdf !== documentId)
					return null;
				const page = Number(element.dataset.annotationPage);
				const state = docCapRef.current?.getDocumentState(documentId);
				const size = state?.document?.pages[page - 1]?.size;
				if (!size || size.width <= 0 || size.height <= 0) return null;
				return {
					page,
					element,
					width: size.width,
					height: size.height,
					rotation: pdfPageRenderRotation(state, page - 1),
				};
			},
		});
		// Keyboard or external zoom during a stroke cancels its old geometry.
		const offZoom = zoom
			?.forDocument(documentId)
			.onZoomChange(() => binding.cancel());
		return () => {
			offZoom?.();
			binding.dispose();
		};
	}, [editor, documentId, enabled, viewportRef, viewport, zoom, docCapRef]);
	return null;
}
