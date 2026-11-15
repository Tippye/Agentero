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
export const INK_LONG_PRESS_MS = 1000;
/** A pen in range keeps new finger gestures out of an active writing session. */
export const INK_PEN_HOVER_GUARD_MS = 1500;
const HOLD_SLOP_PX = 8;
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
	let held: number | null = null;
	let epoch = 0,
		suppressMouseUntil = 0;
	let palm = false,
		disposed = false,
		selecting = false;
	let hoverGuardUntil = 0;
	/** Fingers rejected during pen hover; they stay consumed until they lift. */
	const suppressed = new Set<number>();
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
	/** Hover deliveries have no contact; only a hovering pen arms the guard. */
	const notePenHover = (event: PointerEvent) => {
		if (event.pointerType !== "pen") return;
		hoverGuardUntil =
			event.buttons === 0 ? Date.now() + INK_PEN_HOVER_GUARD_MS : 0;
	};
	const clearHold = () => {
		if (hold) clearTimeout(hold.timer);
		hold = null;
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
		if (excluded(event)) return;
		notePenHover(event);
		if (event.pointerType === "pen") {
			options.onPenDetected?.();
			if (options.automaticPen && !editing()) editor.setMode("pen");
		}
		if (!managed()) return;
		const page = options.pageAt(event.target);
		if (!page) return;
		epoch++;
		clearHold();
		held = null;
		if (event.pointerType === "touch") {
			// A resting hand must not pan, select, or start a stroke while a pen
			// hovers for writing; the finger stays ignored until it lifts.
			if (editing() && Date.now() < hoverGuardUntil) {
				clearHold();
				held = null;
				pan = null;
				suppressed.add(event.pointerId);
				suppressMouseUntil = Date.now() + 1000;
				consume(event);
				return;
			}
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
		};
		if (event.pointerType === "pen" && !eraser) armHold(event, page);
		capture(event.pointerId);
		suppressMouseUntil = Date.now() + 1000;
		consume(event);
	};
	const move = (event: PointerEvent) => {
		if (!managed()) return;
		notePenHover(event);
		if (suppressed.has(event.pointerId)) {
			consume(event);
			return;
		}
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
		queued.push(...(coalesced.length ? coalesced : [event]));
		if (!frame) frame = requestAnimationFrame(flush);
		consume(event);
	};
	const end = (event: PointerEvent) => {
		if (hold?.id === event.pointerId) clearHold();
		if (suppressed.delete(event.pointerId)) {
			release(event.pointerId);
			if (managed()) consume(event);
			return;
		}
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
		if (excluded(event)) return;
		if (
			(editing() || Date.now() < suppressMouseUntil) &&
			event.target instanceof Element &&
			event.target.closest("[data-annotation-page]")
		)
			consume(event);
	};
	const touch = (event: TouchEvent) => {
		if (managed() && (stroke || palm || held !== null)) consume(event);
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
		suppressed.clear();
		hoverGuardUntil = 0;
		palm = false;
	};
	/** Pen leaving the digitizer ends hover protection immediately. */
	const leave = (event: PointerEvent) => {
		if (event.pointerType === "pen") hoverGuardUntil = 0;
	};
	const visibility = () => {
		if (document.visibilityState !== "visible") blur();
	};
	target.addEventListener("pointerdown", down, true);
	target.addEventListener("pointermove", move, true);
	document.addEventListener("pointerup", end, true);
	document.addEventListener("pointercancel", end, true);
	target.addEventListener("lostpointercapture", lostCapture);
	target.addEventListener("pointerleave", leave);
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
			target.removeEventListener("pointerleave", leave);
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
