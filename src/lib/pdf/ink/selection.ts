import type { InteractionManagerCapability } from "@embedpdf/plugin-interaction-manager";
import { glyphAt, type SelectionCapability } from "@embedpdf/plugin-selection";
import type { InkEditor, InkInputPage } from "./editor";
import { type InkPosition, inkHitStroke } from "./geometry";

/** SDK v2 has no imperative selectWord API. Invoke its public page handler,
 * using its existing geometry/selection lifecycle rather than DOM event replay. */
export function createInkLongPressSelection(options: {
	documentId: string;
	editor: InkEditor;
	selection: SelectionCapability;
	interaction: InteractionManagerCapability;
	isCurrent(): boolean;
	requestFrame?: typeof requestAnimationFrame;
	cancelFrame?: typeof cancelAnimationFrame;
}) {
	const request = options.requestFrame ?? requestAnimationFrame;
	const cancel = options.cancelFrame ?? cancelAnimationFrame;
	const frames = new Set<number>();
	let disposed = false;
	return {
		select(
			page: InkInputPage,
			point: InkPosition,
			event: PointerEvent,
			current: () => boolean,
		) {
			if (!current() || !options.isCurrent() || disposed) return;
			if (
				options.editor.controller
					.getPage(page.page)
					.strokes.some((stroke) => inkHitStroke(stroke, point, 8))
			) {
				options.editor.selectAt(page, point);
				return;
			}
			options.editor.setMode("read");
			const run = (remaining: number) => {
				if (disposed || !current() || !options.isCurrent()) return;
				const scope = options.selection.forDocument(options.documentId);
				const geometry = scope.getState().geometry[page.page - 1];
				const interaction = options.interaction.forDocument(options.documentId);
				const handlers = interaction.getHandlersForScope({
					type: "page",
					documentId: options.documentId,
					pageIndex: page.page - 1,
				});
				if ((!geometry || !handlers?.onDoubleClick) && remaining > 0) {
					const id = request(() => {
						frames.delete(id);
						run(remaining - 1);
					});
					frames.add(id);
					return;
				}
				if (
					geometry &&
					handlers?.onDoubleClick &&
					glyphAt(geometry, point) >= 0
				) {
					let stopped = false;
					const pointer = {
						clientX: event.clientX,
						clientY: event.clientY,
						ctrlKey: event.ctrlKey,
						shiftKey: event.shiftKey,
						altKey: event.altKey,
						metaKey: event.metaKey,
						target: page.element,
						currentTarget: page.element,
						detail: 2,
						button: 0,
						buttons: 0,
						preventDefault() {},
						stopImmediatePropagation() {
							stopped = true;
						},
						isImmediatePropagationStopped: () => stopped,
					};
					handlers.onDoubleClick(point, pointer, interaction.getActiveMode());
				} else options.editor.selectAt(page, point);
			};
			run(120);
		},
		dispose() {
			disposed = true;
			for (const id of frames) cancel(id);
			frames.clear();
		},
	};
}
