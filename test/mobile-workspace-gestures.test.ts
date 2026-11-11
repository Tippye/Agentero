// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeSwipeBack } from "@/components/mobile/mobile-gestures";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const back = vi.fn();
const down = vi.fn();
async function render(disabled = false) {
	await act(() =>
		root.render(
			createElement(
				EdgeSwipeBack,
				{ onBack: back, disabled },
				createElement("canvas", { onPointerDown: down }),
			),
		),
	);
}
function touch(
	type: string,
	x: number,
	y: number,
	time: number,
	count = type === "touchend" ? 0 : 1,
) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const point = { clientX: x, clientY: y };
	Object.defineProperties(event, {
		touches: { value: Array.from({ length: count }, () => point) },
		changedTouches: { value: [point] },
		timeStamp: { value: time },
	});
	host.querySelector("canvas")?.dispatchEvent(event);
	return event;
}
function pointer(pointerType: string) {
	const event = new PointerEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		pointerType,
	});
	host.querySelector("canvas")?.dispatchEvent(event);
	return event;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	back.mockClear();
	down.mockClear();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

describe("tablet edge navigation during writing", () => {
	it("passes the first pen down to PDF content and ignores its compatibility touch stream", async () => {
		await render();
		await act(() => {
			const event = pointer("pen");
			expect(event.defaultPrevented).toBe(false);
			touch("touchstart", 2, 20, 0);
			touch("touchend", 150, 20, 150);
		});
		expect(down).toHaveBeenCalledTimes(1);
		expect(back).not.toHaveBeenCalled();
		await act(() => {
			pointer("touch");
			touch("touchstart", 2, 20, 200);
			touch("touchend", 150, 20, 350);
		});
		expect(back).toHaveBeenCalledTimes(1);
	});

	it("suppresses ink/dirty edge navigation without intercepting touch scroll or replacing content", async () => {
		await render(true);
		const canvas = host.querySelector("canvas");
		await act(() => {
			pointer("touch");
			touch("touchstart", 2, 20, 0);
			expect(touch("touchmove", 120, 20, 100).defaultPrevented).toBe(false);
			touch("touchend", 150, 20, 150);
		});
		expect(back).not.toHaveBeenCalled();
		await render(false);
		expect(host.querySelector("canvas")).toBe(canvas);
		await act(() => {
			pointer("touch");
			touch("touchstart", 2, 20, 200);
			expect(touch("touchmove", 2, 180, 250).defaultPrevented).toBe(false);
			touch("touchend", 2, 250, 350);
		});
		expect(back).not.toHaveBeenCalled();
	});

	it("rejects multi-touch and non-edge pans while allowing a committed finger edge swipe", async () => {
		await render();
		await act(() => {
			pointer("touch");
			touch("touchstart", 2, 20, 0);
			touch("touchmove", 80, 20, 100, 2);
			touch("touchend", 150, 20, 150);
			touch("touchstart", 100, 20, 200);
			touch("touchend", 250, 20, 350);
		});
		expect(back).not.toHaveBeenCalled();
		await act(() => {
			touch("touchstart", 2, 20, 400);
			touch("touchend", 150, 20, 550);
		});
		expect(back).toHaveBeenCalledTimes(1);
	});
});
