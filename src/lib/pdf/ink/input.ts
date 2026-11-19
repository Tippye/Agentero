import type { InkEditor, InkInputPage } from "./editor";
import {
	type InkPosition,
	inkPointerSample,
	inkPointFromClient,
} from "./geometry";

export type InkViewport = {
	getMetrics(): { scrollLeft: number; scrollTop: number };
	scrollTo(position: { x: number; y: number; behavior: "instant" }): void;
};
export const INK_LONG_PRESS_MS = 1200;
/** Pausing this long at the end of a pen stroke snaps it to a clean shape. */
export const INK_SHAPE_HOLD_MS = 500;
const HOLD_SLOP_PX = 6;
/** Native modality boundary: provisional ink is never committed by long press/cancel. */
export function bindInkInput(options: {
	target: HTMLElement;
	editor: InkEditor;
	pageAt(target: EventTarget | null): InkInputPage | null;
	viewport(): InkViewport | null;
	automaticPen?: boolean;
	onPenDetected?: () => void;
	onLongPress?: (
		page: InkInputPage,
		point: InkPosition,
		event: PointerEvent,
		current: () => boolean,
	) => void;
}) {
	const { target, editor } = options;
	let stroke: {
		id: number;
		page: InkInputPage;
		started: number;
		lastTime: number;
		eraser: boolean;
	} | null = null;
	const touches = new Map<number, { x: number; y: number }>();
	let pan: {
		id: number;
		x: number;
		y: number;
		left: number;
		top: number;
		moved: boolean;
	} | null = null;
	let hold: {
		id: number;
		page: InkInputPage;
		x: number;
		y: number;
		event: PointerEvent;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	/** Stillness anchor for hold-to-shape; jitter inside the slop keeps it. */
	let shapeHold: {
		id: number;
		x: number;
		y: number;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	let held: number | null = null;
	let epoch = 0,
		suppressMouseUntil = 0;
	let palm = false,
		disposed = false,
		selecting = false;
	let queued: PointerEvent[] = [];
	let frame = 0;
	const originalTouchAction = target.style.touchAction;
	const editing = () => editor.getState().mode !== "read";
	const managed = () => options.automaticPen || editing();
	const capture = (id: number) => {
		try {
			target.setPointerCapture(id);
		} catch {
			/* Document release listeners are the fallback. */
		}
	};
	const release = (id: number) => {
		try {
			if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
		} catch {
			/* Webview already cancelled. */
		}
	};
	const consume = (event: Event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	const clearHold = () => {
		if (hold) clearTimeout(hold.timer);
		hold = null;
	};
	const clearShapeHold = () => {
		if (shapeHold) clearTimeout(shapeHold.timer);
		shapeHold = null;
	};
	/**
	 * Re-arm only after real movement: sub-slop pen jitter must not postpone
	 * the snap forever. Moving again after a snap restores the freehand draft.
	 */
	const armShapeHold = (event: PointerEvent) => {
		const active = stroke;
		if (
			!active ||
			active.eraser ||
			active.id !== event.pointerId ||
			event.pointerType !== "pen"
		)
			return;
		if (
			shapeHold &&
			shapeHold.id === event.pointerId &&
			Math.hypot(event.clientX - shapeHold.x, event.clientY - shapeHold.y) <=
				HOLD_SLOP_PX
		)
			return;
		editor.unsnapDraft();
		clearShapeHold();
		const id = event.pointerId;
		shapeHold = {
			id,
			x: event.clientX,
			y: event.clientY,
			timer: setTimeout(() => {
				if (disposed || shapeHold?.id !== id || stroke?.id !== id) return;
				flush();
				editor.snapDraft();
			}, INK_SHAPE_HOLD_MS),
		};
	};
	const flush = () => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		if (!stroke) {
			queued = [];
			return;
		}
		const current = stroke,
			rect = current.page.element.getBoundingClientRect();
		const samples = [];
		for (const event of queued.sort((a, b) => a.timeStamp - b.timeStamp)) {
			if (event.timeStamp < current.lastTime) continue;
			current.lastTime = event.timeStamp;
			samples.push(
				inkPointerSample(
					event,
					inkPointFromClient(
						{ x: event.clientX, y: event.clientY },
						rect,
						current.page,
					),
					current.started,
				),
			);
		}
		queued = [];
		editor.append(samples);
	};
	const cancel = () => {
		epoch++;
		clearHold();
		clearShapeHold();
		held = null;
		const active = stroke;
		stroke = null;
		queued = [];
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		editor.cancel();
		if (active) release(active.id);
		pan = null;
	};
	let mode = editor.getState().mode;
	const updateTouchAction = () => {
		const next = editor.getState().mode;
		if (next !== mode) {
			mode = next;
			if (!selecting) cancel();
		}
		const action = managed() ? "none" : originalTouchAction;
		if (target.style.touchAction !== action) target.style.touchAction = action;
	};
	const unsubscribe = editor.subscribe(updateTouchAction);
	updateTouchAction();
	const excluded = (event: Event) =>
		event.target instanceof Element &&
		!!event.target.closest(
			"[data-pdf-chrome],button,input,textarea,[contenteditable='true'],[role='dialog']",
		);
	/** Transparent link/figure hit buttons are reading surface: a finger on
	 * them must pan like the rest of the page instead of falling through to
	 * EmbedPDF drag-selection. Their clicks keep the travel-tolerance guard. */
	const pageHitTarget = (event: Event) =>
		event.target instanceof Element &&
		!!event.target.closest("[data-layout-hit],[data-pdf-link-hit]");
	const armHold = (event: PointerEvent, page: InkInputPage) => {
		clearHold();
		const generation = ++epoch;
		hold = {
			id: event.pointerId,
			page,
			x: event.clientX,
			y: event.clientY,
			event,
			timer: setTimeout(() => {
				const pending = hold;
				if (
					!pending ||
					disposed ||
					generation !== epoch ||
					palm ||
					touches.size > 1 ||
					!target.contains(page.element)
				)
					return;
				hold = null;
				const active = stroke;
				stroke = null;
				queued = [];
				if (frame) cancelAnimationFrame(frame);
				frame = 0;
				clearShapeHold();
				editor.cancel();
				if (active) release(active.id);
				pan = null;
				held = event.pointerId;
				suppressMouseUntil = Date.now() + 1000;
				const point = inkPointFromClient(
					{ x: pending.x, y: pending.y },
					page.element.getBoundingClientRect(),
					page,
				);
				// Mode updates during the selection callback are expected, not cancellation.
				const current = () =>
					!disposed && generation === epoch && target.contains(page.element);
				selecting = true;
				try {
					if (options.onLongPress)
						options.onLongPress(page, point, event, current);
					else editor.selectAt(page, point);
				} finally {
					selecting = false;
				}
			}, INK_LONG_PRESS_MS),
		};
	};
	const moveHold = (event: PointerEvent) => {
		if (
			hold?.id === event.pointerId &&
			Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > HOLD_SLOP_PX
		)
			clearHold();
	};
	const down = (event: PointerEvent) => {
		if (excluded(event) && !pageHitTarget(event)) return;
		if (event.pointerType === "pen") {
			options.onPenDetected?.();
			if (options.automaticPen && !editing()) editor.setMode("pen");
		}
		if (!managed()) return;
		const page = options.pageAt(event.target);
		if (!page) return;
		epoch++;
		clearHold();
		clearShapeHold();
		held = null;
		if (event.pointerType === "touch") {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (stroke || palm) {
				clearHold();
				palm = true;
				consume(event);
				return;
			}
			if (touches.size > 1) {
				clearHold();
				epoch++;
				pan = null;
				held = null;
				consume(event);
				return;
			}
			const viewport = options.viewport();
			if (viewport) {
				const metrics = viewport.getMetrics();
				pan = {
					id: event.pointerId,
					x: event.clientX,
					y: event.clientY,
					left: metrics.scrollLeft,
					top: metrics.scrollTop,
					moved: false,
				};
				capture(event.pointerId);
			}
			armHold(event, page);
			suppressMouseUntil = Date.now() + 1000;
			consume(event);
			return;
		}
		if (
			(event.pointerType !== "pen" && event.pointerType !== "mouse") ||
			stroke ||
			(event.button !== 0 &&
				event.button !== 5 &&
				!(event.pointerType === "pen" && event.button === 2))
		)
			return;
		const point = inkPointFromClient(
			{ x: event.clientX, y: event.clientY },
			page.element.getBoundingClientRect(),
			page,
		);
		const eraser =
			event.button === 5 ||
			(event.buttons & 32) !== 0 ||
			(event.pointerType === "pen" && (event.buttons & 2) !== 0);
		if (
			!editor.begin(
				page,
				inkPointerSample(event, point, event.timeStamp),
				eraser,
			)
		)
			return;
		pan = null;
		palm = touches.size > 0;
		held = null;
		stroke = {
			id: event.pointerId,
			page,
			started: event.timeStamp,
			lastTime: event.timeStamp,
			eraser,
		};
		if (event.pointerType === "pen" && !eraser) armHold(event, page);
		capture(event.pointerId);
		suppressMouseUntil = Date.now() + 1000;
		consume(event);
	};
	const move = (event: PointerEvent) => {
		if (!managed()) return;
		moveHold(event);
		if (held === event.pointerId) {
			consume(event);
			return;
		}
		if (event.pointerType === "touch" && touches.has(event.pointerId)) {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (
				pan?.id === event.pointerId &&
				touches.size === 1 &&
				!stroke &&
				!palm
			) {
				if (
					Math.hypot(event.clientX - pan.x, event.clientY - pan.y) >
					HOLD_SLOP_PX
				)
					pan.moved = true;
				if (pan.moved)
					options.viewport()?.scrollTo({
						x: pan.left - (event.clientX - pan.x),
						y: pan.top - (event.clientY - pan.y),
						behavior: "instant",
					});
			}
			consume(event);
			return;
		}
		if (stroke?.id !== event.pointerId) return;
		const coalesced =
			typeof event.getCoalescedEvents === "function"
				? event.getCoalescedEvents()
				: [];
		for (const sample of coalesced) moveHold(sample);
		armShapeHold(event);
		queued.push(...(coalesced.length ? coalesced : [event]));
		if (!frame) frame = requestAnimationFrame(flush);
		consume(event);
	};
	const end = (event: PointerEvent) => {
		if (hold?.id === event.pointerId) clearHold();
		if (
			event.type === "pointercancel" &&
			(stroke?.id === event.pointerId ||
				held === event.pointerId ||
				pan?.id === event.pointerId)
		) {
			cancel();
			touches.delete(event.pointerId);
			consume(event);
			return;
		}
		if (held === event.pointerId) {
			held = null;
			touches.delete(event.pointerId);
			release(event.pointerId);
			suppressMouseUntil = Date.now() + 1000;
			consume(event);
			return;
		}
		if (touches.delete(event.pointerId)) {
			pan = null;
			release(event.pointerId);
			if (!touches.size && !stroke) palm = false;
			if (managed()) consume(event);
			return;
		}
		if (stroke?.id !== event.pointerId) return;
		// Lifting far from the stillness anchor means drawing continued (moves
		// can be coalesced away); commit the freehand ink, not the old snap.
		if (
			shapeHold?.id === event.pointerId &&
			Math.hypot(event.clientX - shapeHold.x, event.clientY - shapeHold.y) >
				HOLD_SLOP_PX
		)
			editor.unsnapDraft();
		clearShapeHold();
		queued.push(event);
		flush();
		const id = stroke.id;
		stroke = null;
		editor.finish();
		release(id);
		if (!touches.size) palm = false;
		suppressMouseUntil = Date.now() + 1000;
		consume(event);
	};
	const mouse = (event: MouseEvent) => {
		// Buttons stay excluded here: a tap on a link/figure hit target must
		// survive the post-touch suppression window and be judged by its
		// travel-tolerance click guard, not swallowed as a compatibility event.
		if (excluded(event)) return;
		if (
			(editing() || Date.now() < suppressMouseUntil) &&
			event.target instanceof Element &&
			event.target.closest("[data-annotation-page]")
		)
			consume(event);
	};
	const touch = (event: TouchEvent) => {
		if (!managed()) return;
		// One finger on the page is our own pan (the ink/selection layer owns the
		// pointer). Consuming every move keeps WebView's native long-press/drag
		// text selection from fighting the scroll. Two fingers are left to the
		// zoom gesture wrapper.
		if (
			stroke ||
			palm ||
			held !== null ||
			(touches.size === 1 && event.type === "touchmove")
		)
			consume(event);
	};
	const lostCapture = (event: PointerEvent) => {
		if (
			stroke?.id === event.pointerId ||
			hold?.id === event.pointerId ||
			pan?.id === event.pointerId
		)
			cancel();
	};
	const blur = () => {
		cancel();
		touches.clear();
		palm = false;
	};
	const visibility = () => {
		if (document.visibilityState !== "visible") blur();
	};
	target.addEventListener("pointerdown", down, true);
	target.addEventListener("pointermove", move, true);
	document.addEventListener("pointerup", end, true);
	document.addEventListener("pointercancel", end, true);
	target.addEventListener("lostpointercapture", lostCapture);
	target.addEventListener("mousedown", mouse, true);
	target.addEventListener("click", mouse, true);
	target.addEventListener("contextmenu", mouse, true);
	target.addEventListener("touchstart", touch, {
		capture: true,
		passive: false,
	});
	target.addEventListener("touchmove", touch, {
		capture: true,
		passive: false,
	});
	window.addEventListener("blur", blur);
	document.addEventListener("visibilitychange", visibility);
	return {
		cancel,
		dispose() {
			disposed = true;
			cancel();
			unsubscribe();
			target.style.touchAction = originalTouchAction;
			target.removeEventListener("pointerdown", down, true);
			target.removeEventListener("pointermove", move, true);
			document.removeEventListener("pointerup", end, true);
			document.removeEventListener("pointercancel", end, true);
			target.removeEventListener("lostpointercapture", lostCapture);
			target.removeEventListener("mousedown", mouse, true);
			target.removeEventListener("click", mouse, true);
			target.removeEventListener("contextmenu", mouse, true);
			target.removeEventListener("touchstart", touch, true);
			target.removeEventListener("touchmove", touch, true);
			window.removeEventListener("blur", blur);
			document.removeEventListener("visibilitychange", visibility);
		},
	};
}
