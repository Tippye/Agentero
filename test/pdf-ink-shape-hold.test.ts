// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkController } from "@/lib/pdf/ink/controller";
import { InkEditor } from "@/lib/pdf/ink/editor";
import { bindInkInput, INK_SHAPE_HOLD_MS } from "@/lib/pdf/ink/input";

let cleanup: () => void = () => {};
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
	cleanup();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
async function reader() {
	const wrapper = document.createElement("div"),
		target = document.createElement("div"),
		pageElement = document.createElement("div");
	pageElement.dataset.annotationPage = "1";
	target.append(pageElement);
	wrapper.append(target);
	document.body.append(wrapper);
	pageElement.getBoundingClientRect = () => new DOMRect(10, 20, 200, 400);
	let strokes: unknown[] = [];
	const snapshot = () => ({
		document: { version: 1, page: 1, strokes, tombstones: [] },
		revision: null,
		creationTimes: {},
		updateTimes: {},
	});
	const apply = vi.fn(async (_page, _revision, operations) => {
		strokes = operations
			.filter((op: { kind: string }) => op.kind === "put")
			.map((op: { stroke: unknown }) => op.stroke);
		return snapshot();
	});
	const controller = new InkController({
		read: async () => snapshot() as never,
		apply: apply as never,
	});
	await controller.load(1);
	const editor = new InkEditor(controller);
	editor.setMode("pen");
	const binding = bindInkInput({
		target,
		editor,
		viewport: () => ({
			getMetrics: () => ({ scrollLeft: 0, scrollTop: 0 }),
			scrollTo: vi.fn(),
		}),
		pageAt: () => ({
			page: 1,
			width: 100,
			height: 200,
			rotation: 0,
			element: pageElement,
		}),
	});
	cleanup = binding.dispose;
	return { pageElement, editor, controller, apply };
}
function pointer(
	target: HTMLElement,
	type: string,
	id: number,
	x: number,
	y: number,
	timestamp: number,
) {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerType: "pen",
		pointerId: id,
		clientX: x,
		clientY: y,
		button: 0,
		buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		pressure: 0.5,
	});
	Object.defineProperty(event, "timeStamp", { value: timestamp });
	target.dispatchEvent(event);
	return event;
}
/** A slightly wobbly horizontal pen line in client coordinates. */
function drawLine(page: HTMLElement) {
	pointer(page, "pointerdown", 1, 30, 40, 10);
	pointer(page, "pointermove", 1, 70, 41, 20);
	pointer(page, "pointermove", 1, 110, 39, 30);
	pointer(page, "pointermove", 1, 150, 40, 40);
}

describe("hold-to-shape input", () => {
	it("snaps a held line and commits the normalized stroke on lift", async () => {
		expect(INK_SHAPE_HOLD_MS).toBe(500);
		const { pageElement, editor, apply } = await reader();
		drawLine(pageElement);
		expect(editor.getState().draft?.snapped).toBeFalsy();
		vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
		const draft = editor.getState().draft;
		expect(draft?.snapped).toBe(true);
		expect(draft?.stroke.points).toHaveLength(2);
		expect(draft?.stroke.points[0].y).toBe(draft?.stroke.points[1].y);
		pointer(pageElement, "pointerup", 1, 150, 40, 600);
		await Promise.resolve();
		expect(apply).toHaveBeenCalledOnce();
		const saved = apply.mock.calls[0][2][0].stroke;
		expect(saved.points).toHaveLength(2);
		expect(saved.points[0]).toMatchObject({ x: 10, y: 10, elapsedMs: 0 });
		// Point times span the drawn path up to the pause, not the hold itself.
		expect(saved.points[1]).toMatchObject({ x: 70, y: 10, elapsedMs: 30 });
		expect(saved.points[0].pressure).toBe(0.5);
		expect(editor.getState().draft).toBeNull();
	});

	it("restores freehand ink when drawing resumes after a snap", async () => {
		const { pageElement, editor, apply } = await reader();
		drawLine(pageElement);
		vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
		expect(editor.getState().draft?.snapped).toBe(true);
		pointer(pageElement, "pointermove", 1, 170, 40, 600);
		const draft = editor.getState().draft;
		expect(draft?.snapped).toBeFalsy();
		expect(draft?.stroke.points.length).toBeGreaterThan(2);
		pointer(pageElement, "pointerup", 1, 170, 40, 650);
		await Promise.resolve();
		const saved = apply.mock.calls[0][2][0].stroke;
		expect(saved.points).toHaveLength(6);
	});

	it("keeps an unrecognized held stroke as ink", async () => {
		const { pageElement, editor, apply } = await reader();
		pointer(pageElement, "pointerdown", 1, 30, 40, 10);
		pointer(pageElement, "pointermove", 1, 50, 80, 20);
		pointer(pageElement, "pointermove", 1, 70, 40, 30);
		pointer(pageElement, "pointermove", 1, 90, 80, 40);
		pointer(pageElement, "pointermove", 1, 110, 40, 50);
		vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
		expect(editor.getState().draft?.snapped).toBeFalsy();
		pointer(pageElement, "pointerup", 1, 110, 40, 600);
		await Promise.resolve();
		const saved = apply.mock.calls[0][2][0].stroke;
		expect(saved.points).toHaveLength(6);
	});

	it("discards a snapped draft on pointercancel without saving", async () => {
		const { pageElement, editor, controller, apply } = await reader();
		drawLine(pageElement);
		vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
		expect(editor.getState().draft?.snapped).toBe(true);
		pointer(pageElement, "pointercancel", 1, 150, 40, 600);
		expect(editor.getState().draft).toBeNull();
		expect(controller.getOverview().dirty).toBe(false);
		expect(apply).not.toHaveBeenCalled();
	});

	it("keeps the snap through sub-slop jitter and commits it on lift", async () => {
		const { pageElement, editor, apply } = await reader();
		drawLine(pageElement);
		vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
		pointer(pageElement, "pointermove", 1, 152, 41, 600);
		pointer(pageElement, "pointermove", 1, 151, 40, 610);
		expect(editor.getState().draft?.snapped).toBe(true);
		pointer(pageElement, "pointerup", 1, 151, 40, 620);
		await Promise.resolve();
		const saved = apply.mock.calls[0][2][0].stroke;
		expect(saved.points).toHaveLength(2);
	});

	it("commits freehand when lifting far from the pause point", async () => {
		const { pageElement, apply } = await reader();
		drawLine(pageElement);
		vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
		pointer(pageElement, "pointerup", 1, 190, 40, 600);
		await Promise.resolve();
		const saved = apply.mock.calls[0][2][0].stroke;
		expect(saved.points).toHaveLength(5);
	});

	it("never snaps the eraser and snaps the highlighter like the pen", async () => {
		const { pageElement, editor, apply } = await reader();
		editor.setMode("eraser");
		pointer(pageElement, "pointerdown", 1, 30, 40, 10);
		pointer(pageElement, "pointermove", 1, 150, 40, 40);
		vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
		expect(editor.getState().draft).toBeNull();
		pointer(pageElement, "pointerup", 1, 150, 40, 600);
		await Promise.resolve();
		expect(apply).not.toHaveBeenCalled();
		editor.setMode("highlighter");
		pointer(pageElement, "pointerdown", 2, 30, 80, 700);
		pointer(pageElement, "pointermove", 2, 150, 80, 740);
		vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
		expect(editor.getState().draft?.snapped).toBe(true);
		pointer(pageElement, "pointerup", 2, 150, 80, 1200);
		await Promise.resolve();
		const saved = apply.mock.calls[0][2][0].stroke;
		expect(saved.tool).toBe("highlighter");
		expect(saved.points).toHaveLength(2);
	});
});
