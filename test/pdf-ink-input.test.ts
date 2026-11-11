// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkController } from "@/lib/pdf/ink/controller";
import { InkEditor } from "@/lib/pdf/ink/editor";
import { bindInkInput } from "@/lib/pdf/ink/input";

let cleanup: () => void = () => {};
beforeEach(() => {
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
	cleanup();
	document.body.replaceChildren();
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
	const viewport = {
		getMetrics: () => ({ scrollLeft: 100, scrollTop: 200 }),
		scrollTo: vi.fn(),
	};
	const binding = bindInkInput({
		target,
		editor,
		viewport: () => viewport,
		pageAt: () => ({
			page: 1,
			width: 100,
			height: 200,
			rotation: 0,
			element: pageElement,
		}),
	});
	cleanup = binding.dispose;
	return { wrapper, target, pageElement, editor, controller, apply, viewport };
}
function pointer(
	target: HTMLElement,
	type: string,
	pointerType: string,
	id: number,
	x: number,
	y: number,
	timestamp = 10,
	pressure = 0.5,
	coalesced?: PointerEvent[],
) {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerType,
		pointerId: id,
		clientX: x,
		clientY: y,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		pressure,
	});
	Object.defineProperty(event, "timeStamp", { value: timestamp });
	if (coalesced)
		Object.defineProperty(event, "getCoalescedEvents", {
			value: () => coalesced,
		});
	target.dispatchEvent(event);
	return event;
}

describe("ink pointer modality boundary", () => {
	it("draws coalesced stylus samples with real zero pressure and cancels a draft without saving", async () => {
		const { pageElement, controller, editor, apply } = await reader();
		pointer(pageElement, "pointerdown", "pen", 1, 30, 40, 10, 0);
		expect(controller.getOverview().dirty).toBe(true);
		const events = [
			new PointerEvent("pointermove", {
				pointerType: "pen",
				pressure: 0.8,
				clientX: 60,
				clientY: 70,
			}),
			new PointerEvent("pointermove", {
				pointerType: "pen",
				pressure: 1,
				clientX: 70,
				clientY: 80,
			}),
		];
		Object.defineProperty(events[0], "timeStamp", { value: 20 });
		Object.defineProperty(events[1], "timeStamp", { value: 25 });
		pointer(pageElement, "pointermove", "pen", 1, 70, 80, 25, 1, events);
		pointer(pageElement, "pointerup", "pen", 1, 75, 85, 30, 0);
		await vi.waitFor(() => expect(controller.getOverview().dirty).toBe(false));
		const saved = apply.mock.calls[0][2][0].stroke;
		expect(saved.points.map((p: { pressure: number }) => p.pressure)).toEqual([
			0, 0.8, 1, 0,
		]);
		expect(saved.points[0]).toMatchObject({ x: 10, y: 10, elapsedMs: 0 });
		pointer(pageElement, "pointerdown", "pen", 2, 50, 50, 40);
		pointer(pageElement, "pointercancel", "pen", 2, 70, 70, 50);
		expect(editor.getState().draft).toBe(null);
		expect(controller.getOverview().dirty).toBe(false);
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("pans with one finger via public viewport scrolling and hands two fingers to the enclosing pinch wrapper", async () => {
		const { wrapper, pageElement, viewport, editor, apply } = await reader();
		const pinchRoute = vi.fn();
		wrapper.addEventListener("touchstart", pinchRoute);
		pointer(pageElement, "pointerdown", "touch", 11, 60, 80);
		pointer(pageElement, "pointermove", "touch", 11, 80, 110);
		expect(viewport.scrollTo).toHaveBeenCalledWith({
			x: 80,
			y: 170,
			behavior: "instant",
		});
		pageElement.dispatchEvent(
			new Event("touchstart", { bubbles: true, cancelable: true }),
		);
		pointer(pageElement, "pointerdown", "touch", 12, 100, 120);
		pageElement.dispatchEvent(
			new Event("touchstart", { bubbles: true, cancelable: true }),
		);
		pointer(pageElement, "pointermove", "touch", 11, 90, 130);
		expect(viewport.scrollTo).toHaveBeenCalledTimes(1);
		expect(pinchRoute).toHaveBeenCalledTimes(2);
		expect(editor.getState().draft).toBe(null);
		expect(apply).not.toHaveBeenCalled();
	});

	it("rejects palm touch navigation and pinch while the stylus is down, without cancelling the pen", async () => {
		const { wrapper, pageElement, viewport, editor, controller, apply } =
			await reader();
		const pinchRoute = vi.fn();
		wrapper.addEventListener("touchstart", pinchRoute);
		pointer(pageElement, "pointerdown", "pen", 1, 50, 50);
		pointer(pageElement, "pointerdown", "touch", 2, 70, 80);
		pointer(pageElement, "pointermove", "touch", 2, 100, 130);
		pageElement.dispatchEvent(
			new Event("touchstart", { bubbles: true, cancelable: true }),
		);
		expect(viewport.scrollTo).not.toHaveBeenCalled();
		expect(pinchRoute).not.toHaveBeenCalled();
		expect(editor.getState().draft).not.toBe(null);
		pointer(pageElement, "pointerup", "pen", 1, 60, 60, 30);
		pointer(pageElement, "pointerup", "touch", 2, 100, 130);
		await vi.waitFor(() => expect(controller.getOverview().dirty).toBe(false));
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("discards the active draft on blur and restores the original touch-action when disposed", async () => {
		const { pageElement, target, editor, controller, apply } = await reader();
		pointer(pageElement, "pointerdown", "pen", 1, 50, 50);
		window.dispatchEvent(new Event("blur"));
		expect(editor.getState().draft).toBe(null);
		expect(controller.getOverview().dirty).toBe(false);
		expect(apply).not.toHaveBeenCalled();
		expect(target.style.touchAction).toBe("none");
		cleanup();
		cleanup = () => {};
		expect(target.style.touchAction).not.toBe("none");
	});
});
