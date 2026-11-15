import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { useInteractionManagerCapability } from "@embedpdf/plugin-interaction-manager/react";
import { useSelectionCapability } from "@embedpdf/plugin-selection/react";
import {
	useViewportCapability,
	useViewportElement,
} from "@embedpdf/plugin-viewport/react";
import { useZoomCapability } from "@embedpdf/plugin-zoom/react";
import { type RefObject, useEffect } from "react";
import { pdfPageRenderRotation } from "@/components/viewer/pdf/layers/agentero-render-layer";
import {
	activateStylusTarget,
	isStylusTarget,
	observeStylusPointerPresence,
	subscribeStylusActions,
	subscribeStylusPresence,
} from "@/lib/mobile/stylus";
import type { InkEditor, InkInputPage } from "@/lib/pdf/ink/editor";
import type { InkPosition } from "@/lib/pdf/ink/geometry";
import { bindInkInput } from "@/lib/pdf/ink/input";
import { createInkLongPressSelection } from "@/lib/pdf/ink/selection";

/** Public viewport scrolling plus the enclosing ZoomGestureWrapper handle fingers. */
export function InkInputBridge({
	editor,
	documentId,
	enabled,
	docCapRef,
	onLongPressNote,
}: {
	editor: InkEditor | null;
	documentId: string;
	enabled: boolean;
	docCapRef: RefObject<
		ReturnType<typeof useDocumentManagerCapability>["provides"]
	>;
	onLongPressNote?: (
		page: InkInputPage,
		point: InkPosition,
		event: PointerEvent,
		current: () => boolean,
	) => void;
}) {
	const viewportRef = useViewportElement();
	const { provides: viewport } = useViewportCapability();
	const { provides: zoom } = useZoomCapability();
	const { provides: selection } = useSelectionCapability();
	const { provides: interaction } = useInteractionManagerCapability();
	useEffect(() => {
		const target = viewportRef?.current;
		if (!enabled || !editor || !target || !viewport) return;
		let disposed = false,
			observed = false;
		const document = docCapRef.current?.getDocument(documentId);
		const selector =
			selection && interaction
				? createInkLongPressSelection({
						documentId,
						editor,
						selection,
						interaction,
						isCurrent: () =>
							!disposed &&
							docCapRef.current?.getDocument(documentId) === document,
					})
				: null;
		let deactivate = () => {};
		let visible = false,
			intersecting = false;
		const binding = bindInkInput({
			target,
			editor,
			automaticPen: true,
			onPenDetected: () => {
				if (!observed && isStylusTarget(documentId)) {
					observed = true;
					observeStylusPointerPresence(true);
				}
			},
			onLongPress: (page, point, event, current) => {
				if (selector) selector.select(page, point, event, current);
				else editor.selectAt(page, point);
			},
			onLongPressNote,
			onTap: () => {
				const scope = selection?.forDocument(documentId);
				if (scope?.getState().selection) scope.clear();
			},
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
		const updateVisibility = () => {
			const next =
				intersecting && target.ownerDocument.visibilityState !== "hidden";
			if (next === visible) return;
			visible = next;
			deactivate();
			deactivate = next ? activateStylusTarget(documentId) : () => {};
			if (!next) binding.cancel();
		};
		const visibility =
			typeof IntersectionObserver !== "undefined"
				? new IntersectionObserver((entries) => {
						intersecting = entries.some((entry) => entry.isIntersecting);
						updateVisibility();
					})
				: null;
		if (visibility) visibility.observe(target);
		else {
			intersecting = true;
			updateVisibility();
		}
		target.ownerDocument.addEventListener("visibilitychange", updateVisibility);
		const offActions = subscribeStylusActions((event) => {
			if (!disposed && visible && isStylusTarget(documentId)) {
				binding.cancel();
				editor.applyStylusAction(event.action);
			}
		});
		const offPresence = subscribeStylusPresence((presence) => {
			if (!disposed) {
				target.dataset.stylusSource = presence.source;
				target.dataset.stylusAvailable = String(presence.available);
			}
		});
		// Keyboard or external zoom during a stroke cancels its old geometry.
		const offZoom = zoom
			?.forDocument(documentId)
			.onZoomChange(() => binding.cancel());
		return () => {
			disposed = true;
			visibility?.disconnect();
			target.ownerDocument.removeEventListener(
				"visibilitychange",
				updateVisibility,
			);
			offActions();
			offPresence();
			deactivate();
			selector?.dispose();
			offZoom?.();
			binding.dispose();
			delete target.dataset.stylusSource;
			delete target.dataset.stylusAvailable;
		};
	}, [
		editor,
		documentId,
		enabled,
		viewportRef,
		viewport,
		zoom,
		docCapRef,
		selection,
		interaction,
		onLongPressNote,
	]);
	return null;
}
