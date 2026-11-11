import type { InkEditor, InkInputPage } from "./editor";
import { inkPointerSample, inkPointFromClient } from "./geometry";

export type InkViewport = {
	getMetrics(): { scrollLeft: number; scrollTop: number };
	scrollTo(position: { x: number; y: number; behavior: "instant" }): void;
};
/** Native pointer boundary; touch samples are never converted into ink. */
export function bindInkInput(options: {
	target: HTMLElement;
	editor: InkEditor;
	pageAt(target: EventTarget | null): InkInputPage | null;
	viewport(): InkViewport | null;
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
	} | null = null;
	let palm = false;
	let queued: PointerEvent[] = [];
	let frame = 0;
	const originalTouchAction = target.style.touchAction;
	const editing = () => editor.getState().mode !== "read";
	const capture = (id: number) => {
		try {
			target.setPointerCapture(id);
		} catch {
			/* Global release listeners still end the gesture. */
		}
	};
	const release = (id: number) => {
		try {
			if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
		} catch {
			/* Already cancelled by the webview. */
		}
	};
	const consume = (event: Event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	const flush = () => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		if (!stroke) {
			queued = [];
			return;
		}
		const current = stroke;
		const rect = current.page.element.getBoundingClientRect();
		const samples = queued
			.filter((event) => event.timeStamp >= current.lastTime)
			.map((event) => {
				current.lastTime = event.timeStamp;
				return inkPointerSample(
					event,
					inkPointFromClient(
						{ x: event.clientX, y: event.clientY },
						rect,
						current.page,
					),
					current.started,
				);
			});
		queued = [];
		editor.append(samples);
	};
	const cancel = () => {
		const active = stroke;
		stroke = null;
		queued = [];
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		editor.cancel();
		if (active) release(active.id);
		pan = null;
	};
	const updateTouchAction = () => {
		target.style.touchAction = editing() ? "none" : originalTouchAction;
		if (!editing()) cancel();
	};
	const unsubscribe = editor.subscribe(updateTouchAction);
	updateTouchAction();
	const excluded = (event: PointerEvent) =>
		event.target instanceof Element &&
		!!event.target.closest(
			"[data-pdf-chrome],button,input,textarea,[contenteditable='true'],[role='dialog']",
		);
	const down = (event: PointerEvent) => {
		if (!editing() || excluded(event)) return;
		if (event.pointerType === "touch") {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (stroke || palm) {
				palm = true;
				consume(event);
				return;
			}
			const viewport = options.viewport();
			if (touches.size === 1 && viewport) {
				const metrics = viewport.getMetrics();
				pan = {
					id: event.pointerId,
					x: event.clientX,
					y: event.clientY,
					left: metrics.scrollLeft,
					top: metrics.scrollTop,
				};
				capture(event.pointerId);
			} else pan = null;
			// Two-finger touch events still reach the existing ZoomGestureWrapper.
			consume(event);
			return;
		}
		if (
			(event.pointerType !== "pen" && event.pointerType !== "mouse") ||
			stroke ||
			(event.button !== 0 && event.button !== 5)
		)
			return;
		const page = options.pageAt(event.target);
		if (!page) return;
		const point = inkPointFromClient(
			{ x: event.clientX, y: event.clientY },
			page.element.getBoundingClientRect(),
			page,
		);
		const sample = inkPointerSample(event, point, event.timeStamp);
		if (
			!editor.begin(
				page,
				sample,
				event.button === 5 || (event.buttons & 32) !== 0,
			)
		)
			return;
		pan = null;
		palm = touches.size > 0;
		stroke = {
			id: event.pointerId,
			page,
			started: event.timeStamp,
			lastTime: event.timeStamp,
		};
		capture(event.pointerId);
		consume(event);
	};
	const move = (event: PointerEvent) => {
		if (!editing()) return;
		if (event.pointerType === "touch" && touches.has(event.pointerId)) {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (
				pan?.id === event.pointerId &&
				touches.size === 1 &&
				!stroke &&
				!palm
			) {
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
		queued.push(...(coalesced.length ? coalesced : [event]));
		if (!frame) frame = requestAnimationFrame(flush);
		consume(event);
	};
	const end = (event: PointerEvent) => {
		if (touches.delete(event.pointerId)) {
			pan = null;
			if (!touches.size && !stroke) palm = false;
			if (editing()) consume(event);
			return;
		}
		if (stroke?.id !== event.pointerId) return;
		if (event.type === "pointercancel") {
			cancel();
			consume(event);
			return;
		}
		queued.push(event);
		flush();
		const id = stroke.id;
		stroke = null;
		editor.finish();
		release(id);
		if (!touches.size) palm = false;
		consume(event);
	};
	const mouse = (event: MouseEvent) => {
		if (
			editing() &&
			(stroke ||
				(event.target instanceof Element &&
					!!event.target.closest("[data-annotation-page]")))
		)
			consume(event);
	};
	const touch = (event: TouchEvent) => {
		if (editing() && (stroke || palm)) consume(event);
	};
	const lostCapture = (event: PointerEvent) => {
		if (stroke?.id === event.pointerId) cancel();
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
	// A pen release outside the viewport still finishes, even without capture.
	document.addEventListener("pointerup", end, true);
	document.addEventListener("pointercancel", end, true);
	target.addEventListener("lostpointercapture", lostCapture);
	target.addEventListener("mousedown", mouse, true);
	target.addEventListener("click", mouse, true);
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
			target.removeEventListener("touchstart", touch, true);
			target.removeEventListener("touchmove", touch, true);
			window.removeEventListener("blur", blur);
			document.removeEventListener("visibilitychange", visibility);
		},
	};
}
