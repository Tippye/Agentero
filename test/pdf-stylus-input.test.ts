// @vitest-environment happy-dom
import {
	PluginRegistry,
	setDocumentLoaded,
	startLoadingDocument,
} from "@embedpdf/core";
import {
	type PdfDocumentObject,
	type PdfEngine,
	PdfTaskHelper,
} from "@embedpdf/models";
import {
	type InteractionManagerPlugin,
	InteractionManagerPluginPackage,
} from "@embedpdf/plugin-interaction-manager";
import {
	type SelectionPlugin,
	SelectionPluginPackage,
} from "@embedpdf/plugin-selection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkController } from "@/lib/pdf/ink/controller";
import { InkEditor } from "@/lib/pdf/ink/editor";
import {
	bindInkInput,
	INK_LONG_PRESS_MS,
	INK_PEN_HOVER_GUARD_MS,
} from "@/lib/pdf/ink/input";
import { createInkLongPressSelection } from "@/lib/pdf/ink/selection";

const native = vi.hoisted(() => ({
	key: null as string | null,
	actions: new Set<(event: { action: "nextColor" }) => void>(),
	viewport: null as { current: HTMLElement } | null,
	observers: [] as ((entries: { isIntersecting: boolean }[]) => void)[],
}));
vi.mock("@/lib/mobile/stylus", () => ({
	activateStylusTarget: (key: string) => {
		native.key = key;
		return () => {
			if (native.key === key) native.key = null;
		};
	},
	isStylusTarget: (key: string) => native.key === key,
	subscribeStylusActions: (fn: (event: { action: "nextColor" }) => void) => {
		native.actions.add(fn);
		return () => native.actions.delete(fn);
	},
	subscribeStylusPresence: () => () => {},
	observeStylusPointerPresence() {},
}));
vi.mock("@embedpdf/plugin-viewport/react", async (original) => ({
	...(await original<object>()),
	useViewportElement: () => native.viewport,
	useViewportCapability: () => ({
		provides: {
			forDocument: () => ({
				getMetrics: () => ({ scrollLeft: 0, scrollTop: 0 }),
				scrollTo() {},
			}),
		},
	}),
}));
vi.mock("@embedpdf/plugin-zoom/react", async (original) => ({
	...(await original<object>()),
	useZoomCapability: () => ({ provides: null }),
}));
vi.mock("@embedpdf/plugin-selection/react", async (original) => ({
	...(await original<object>()),
	useSelectionCapability: () => ({ provides: null }),
}));
vi.mock("@embedpdf/plugin-interaction-manager/react", async (original) => ({
	...(await original<object>()),
	useInteractionManagerCapability: () => ({ provides: null }),
}));
let dispose = () => {};
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
		setTimeout(() => fn(0), 16),
	);
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
afterEach(() => {
	dispose();
	dispose = () => {};
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
async function reader(
	onLongPress?: Parameters<typeof bindInkInput>[0]["onLongPress"],
) {
	const target = document.createElement("div"),
		page = document.createElement("div");
	page.dataset.annotationPage = "1";
	target.append(page);
	document.body.append(target);
	page.getBoundingClientRect = () => new DOMRect(10, 20, 200, 400);
	let strokes: unknown[] = [];
	const snapshot = () => ({
		document: { version: 1, page: 1, strokes, tombstones: [] },
		revision: null,
		creationTimes: {},
		updateTimes: {},
	});
	const apply = vi.fn(async (_page, _revision, ops) => {
		strokes = ops
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
	const viewport = {
		getMetrics: () => ({ scrollLeft: 100, scrollTop: 200 }),
		scrollTo: vi.fn(),
	};
	const binding = bindInkInput({
		target,
		editor,
		automaticPen: true,
		pageAt: () => ({
			page: 1,
			width: 100,
			height: 200,
			rotation: 0,
			element: page,
		}),
		viewport: () => viewport,
		onLongPress,
	});
	dispose = binding.dispose;
	return { target, page, editor, controller, apply, viewport, binding };
}
function pointer(
	page: HTMLElement,
	type: string,
	pointerType: string,
	id = 1,
	x = 50,
	y = 60,
	buttons = type === "pointerup" || type === "pointercancel" ? 0 : 1,
	button = 0,
) {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerType,
		pointerId: id,
		clientX: x,
		clientY: y,
		pressure: type === "pointerdown" ? 0 : 0.8,
		button,
		buttons,
	});
	page.dispatchEvent(event);
	return event;
}
function hover(page: HTMLElement, x = 50, y = 60) {
	page.dispatchEvent(
		new PointerEvent("pointermove", {
			bubbles: true,
			cancelable: true,
			pointerType: "pen",
			pointerId: 9,
			clientX: x,
			clientY: y,
			pressure: 0,
			buttons: 0,
		}),
	);
}
it("keeps touch selection deliberate and the pen hover guard long", () => {
	expect(INK_LONG_PRESS_MS).toBe(1000);
	expect(INK_PEN_HOVER_GUARD_MS).toBe(1500);
});

describe("automatic stylus and long-press arbitration", () => {
	it("draws with the first pen event from read mode and keeps zero pressure and one native commit", async () => {
		const r = await reader();
		expect(r.editor.getState().mode).toBe("read");
		pointer(r.page, "pointerdown", "pen");
		pointer(r.page, "pointermove", "pen", 1, 80, 90);
		vi.advanceTimersByTime(INK_LONG_PRESS_MS + 1);
		pointer(r.page, "pointerup", "pen", 1, 100, 110);
		await Promise.resolve();
		expect(r.apply).toHaveBeenCalledOnce();
		expect(r.apply.mock.calls[0][2][0].stroke.points[0].pressure).toBe(0);
		expect(r.controller.getOverview().canUndo).toBe(true);
	});
	it.each([
		"pen",
		"touch",
	])("selects on %s long press without a dot, save, tombstone or undo entry; release keeps selection", async (kind) => {
		const r = await reader();
		pointer(r.page, "pointerdown", kind);
		vi.advanceTimersByTime(INK_LONG_PRESS_MS);
		expect(r.editor.getState().selection?.bounds).not.toBeNull();
		const selection = r.editor.getState().selection;
		pointer(r.page, "pointerup", kind);
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		r.page.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(r.editor.getState().selection).toEqual(selection);
		expect(r.apply).not.toHaveBeenCalled();
		expect(r.controller.getOverview()).toMatchObject({
			dirty: false,
			canUndo: false,
		});
		const context = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
		});
		r.page.dispatchEvent(context);
		expect(context.defaultPrevented).toBe(true);
	});
	it("finger movement pans in read/pen mode and cancels the hold; two fingers hand touch events to pinch", async () => {
		const r = await reader();
		pointer(r.page, "pointerdown", "touch");
		pointer(r.page, "pointermove", "touch", 1, 80, 90);
		vi.advanceTimersByTime(1000);
		expect(r.viewport.scrollTo).toHaveBeenCalledWith({
			x: 70,
			y: 170,
			behavior: "instant",
		});
		expect(r.editor.getState().selection).toBeNull();
		pointer(r.page, "pointerup", "touch");
		const touchRoute = vi.fn();
		r.target.addEventListener("touchstart", touchRoute);
		pointer(r.page, "pointerdown", "touch", 2);
		pointer(r.page, "pointerdown", "touch", 3, 100, 100);
		r.page.dispatchEvent(new Event("touchstart", { bubbles: true }));
		vi.advanceTimersByTime(1000);
		expect(touchRoute).toHaveBeenCalledOnce();
		expect(r.editor.getState().selection).toBeNull();
		expect(r.apply).not.toHaveBeenCalled();
	});
	it("palm contact cancels long-press selection but preserves the active pen stroke", async () => {
		const r = await reader();
		pointer(r.page, "pointerdown", "pen");
		pointer(r.page, "pointerdown", "touch", 2);
		vi.advanceTimersByTime(1000);
		expect(r.editor.getState().draft).not.toBeNull();
		expect(r.editor.getState().selection).toBeNull();
		pointer(r.page, "pointermove", "pen", 1, 90, 100);
		pointer(r.page, "pointerup", "pen", 1, 100, 110);
		await Promise.resolve();
		expect(r.apply).toHaveBeenCalledOnce();
		expect(r.viewport.scrollTo).not.toHaveBeenCalled();
	});
	it.each([
		"pointercancel",
		"lostpointercapture",
		"blur",
	])("discards a provisional stroke and timer on %s", async (type) => {
		const r = await reader();
		pointer(r.page, "pointerdown", "pen");
		if (type === "blur") window.dispatchEvent(new Event("blur"));
		else
			pointer(type === "lostpointercapture" ? r.target : r.page, type, "pen");
		vi.advanceTimersByTime(1000);
		expect(r.apply).not.toHaveBeenCalled();
		expect(r.editor.getState().selection).toBeNull();
		expect(r.controller.getOverview().dirty).toBe(false);
	});
	it("recognizes standard inverted and barrel eraser buttons without changing persistent pen tool", async () => {
		const r = await reader();
		pointer(r.page, "pointerdown", "pen", 1, 50, 60, 32, 5);
		expect(r.editor.getState().erasing).not.toBeNull();
		pointer(r.page, "pointercancel", "pen");
		pointer(r.page, "pointerdown", "pen", 2, 50, 60, 2, 2);
		expect(r.editor.getState().erasing).not.toBeNull();
		pointer(r.page, "pointercancel", "pen", 2);
		expect(r.apply).not.toHaveBeenCalled();
		r.editor.applyStylusAction("toggleEraser");
		expect(r.editor.getState().mode).toBe("eraser");
		r.editor.applyStylusAction("toggleEraser");
		expect(r.editor.getState().mode).toBe("pen");
		r.editor.applyStylusAction("nextColor");
		expect(r.editor.getState().color).toBe("#c92a2a");
		r.editor.applyStylusAction("showColorPalette");
		expect(r.editor.getState().paletteRequest).toBe(1);
		r.editor.applyStylusAction("select");
		expect(r.editor.getState().mode).toBe("lasso");
	});
	it("keeps a hovering pen's resting hand from panning or selecting until the guard expires", async () => {
		const r = await reader();
		r.editor.setMode("pen");
		hover(r.page);
		pointer(r.page, "pointerdown", "touch", 2);
		pointer(r.page, "pointermove", "touch", 2, 90, 100);
		vi.advanceTimersByTime(INK_LONG_PRESS_MS + 1);
		expect(r.viewport.scrollTo).not.toHaveBeenCalled();
		expect(r.editor.getState().selection).toBeNull();
		expect(r.editor.getState().draft).toBeNull();
		pointer(r.page, "pointerup", "touch", 2);
		vi.advanceTimersByTime(INK_PEN_HOVER_GUARD_MS);
		pointer(r.page, "pointerdown", "touch", 3);
		pointer(r.page, "pointermove", "touch", 3, 80, 90);
		expect(r.viewport.scrollTo).toHaveBeenCalledWith({
			x: 70,
			y: 170,
			behavior: "instant",
		});
	});
	it("still inks a pen contact while a resting hand is suppressed", async () => {
		const r = await reader();
		r.editor.setMode("pen");
		hover(r.page);
		pointer(r.page, "pointerdown", "touch", 2);
		pointer(r.page, "pointerdown", "pen", 1, 50, 60);
		expect(r.editor.getState().draft?.stroke.points.length).toBe(1);
		pointer(r.page, "pointermove", "pen", 1, 80, 90);
		pointer(r.page, "pointerup", "pen", 1, 100, 110);
		await Promise.resolve();
		expect(r.apply).toHaveBeenCalledOnce();
		expect(r.viewport.scrollTo).not.toHaveBeenCalled();
	});
	it("leaves finger navigation alone in read mode while a pen only hovers", async () => {
		const r = await reader();
		expect(r.editor.getState().mode).toBe("read");
		hover(r.page);
		pointer(r.page, "pointerdown", "touch", 2);
		pointer(r.page, "pointermove", "touch", 2, 80, 90);
		expect(r.viewport.scrollTo).toHaveBeenCalledWith({
			x: 70,
			y: 170,
			behavior: "instant",
		});
	});
});

it("selects a word via the REAL pinned SDK public handler and emits its end-selection event, with no DOM replay", async () => {
	const geometry = {
		runs: [
			{
				charStart: 0,
				rect: { x: 15, y: 15, width: 30, height: 12 },
				glyphs: [0, 1, 2].map((i) => ({
					x: 15 + i * 10,
					y: 15,
					width: 10,
					height: 12,
					flags: 0,
				})),
			},
		],
	};
	const registry = new PluginRegistry({
		getPageGeometry: () => PdfTaskHelper.resolve(geometry),
	} as unknown as PdfEngine);
	registry.registerPlugin(InteractionManagerPluginPackage);
	registry.registerPlugin(SelectionPluginPackage);
	await registry.initialize();
	registry.getStore().dispatchToCore(startLoadingDocument("doc"));
	registry.getStore().dispatchToCore(
		setDocumentLoaded("doc", {
			id: "doc",
			pages: [{ index: 0, size: { width: 100, height: 200 }, rotation: 0 }],
			pageCount: 1,
		} as PdfDocumentObject),
	);
	const selectionPlugin = registry.getPlugin<SelectionPlugin>("selection");
	const interaction = registry
		.getPlugin<InteractionManagerPlugin>("interaction-manager")
		?.provides();
	if (!selectionPlugin || !interaction) throw Error("SDK plugins missing");
	const selection = selectionPlugin.provides();
	selection.enableForMode(
		interaction.getDefaultMode(),
		{ enableSelection: true },
		"doc",
	);
	const unregister = selectionPlugin.registerSelectionOnPage({
		documentId: "doc",
		pageIndex: 0,
		onRectsChange() {},
	});
	const ended = vi.fn();
	const offEnd = selection.forDocument("doc").onEndSelection(ended);
	await Promise.resolve();
	let selector: ReturnType<typeof createInkLongPressSelection>;
	const r = await reader((page, point, event, current) =>
		selector.select(page, point, event, current),
	);
	selector = createInkLongPressSelection({
		documentId: "doc",
		editor: r.editor,
		selection,
		interaction,
		isCurrent: () => true,
	});
	const replay = vi.fn();
	r.page.addEventListener("dblclick", replay);
	try {
		pointer(r.page, "pointerdown", "pen");
		vi.advanceTimersByTime(INK_LONG_PRESS_MS);
		pointer(r.page, "pointerup", "pen");
		expect(selection.forDocument("doc").getState().selection).toEqual({
			start: { page: 0, index: 0 },
			end: { page: 0, index: 2 },
		});
		expect(ended).toHaveBeenCalledOnce();
		expect(replay).not.toHaveBeenCalled();
		expect(r.apply).not.toHaveBeenCalled();
	} finally {
		selector.dispose();
		offEnd();
		unregister();
		await registry.destroy();
	}
});

it("admits native actions only to the current visible PDF owner and releases that target on hide", async () => {
	const { act, createElement } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { InkInputBridge } = await import(
		"@/components/viewer/pdf/viewport/ink-input-bridge"
	);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	native.observers = [];
	native.actions.clear();
	native.key = null;
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(fn: (typeof native.observers)[number]) {
				native.observers.push(fn);
			}
			observe() {}
			disconnect() {}
		},
	);
	const a = await reader(),
		b = await reader();
	a.binding.dispose();
	b.binding.dispose();
	const rootA = createRoot(document.createElement("div")),
		rootB = createRoot(document.createElement("div"));
	const docCapRef = {
		current: { getDocument: () => ({ id: "doc" }) },
	} as never;
	try {
		native.viewport = { current: a.target };
		await act(() =>
			rootA.render(
				createElement(InkInputBridge, {
					editor: a.editor,
					documentId: "a",
					enabled: true,
					docCapRef,
				}),
			),
		);
		await act(() => native.observers[0]([{ isIntersecting: true }]));
		native.viewport = { current: b.target };
		await act(() =>
			rootB.render(
				createElement(InkInputBridge, {
					editor: b.editor,
					documentId: "b",
					enabled: true,
					docCapRef,
				}),
			),
		);
		await act(() => native.observers[1]([{ isIntersecting: true }]));
		await act(() => {
			for (const listener of native.actions) listener({ action: "nextColor" });
		});
		expect(a.editor.getState().color).toBe("#202124");
		expect(b.editor.getState().color).toBe("#c92a2a");
		await act(() => native.observers[1]([{ isIntersecting: false }]));
		expect(native.key).toBeNull();
		await act(() => {
			for (const listener of native.actions) listener({ action: "nextColor" });
		});
		expect(b.editor.getState().color).toBe("#c92a2a");
	} finally {
		await act(() => {
			rootA.unmount();
			rootB.unmount();
		});
		native.actions.clear();
	}
});

it("never dispatches a late selection after source disposal or a second gesture", async () => {
	const handler = vi.fn();
	let currentDocument = true;
	const r = await reader();
	const selector = createInkLongPressSelection({
		documentId: "doc",
		editor: r.editor,
		selection: {
			forDocument: () => ({ getState: () => ({ geometry: {} }) }),
		} as never,
		interaction: {
			forDocument: () => ({
				getHandlersForScope: () => ({ onDoubleClick: handler }),
				getActiveMode: () => "pointer",
			}),
		} as never,
		isCurrent: () => currentDocument,
	});
	selector.select(
		{ page: 1, width: 100, height: 200, rotation: 0, element: r.page },
		{ x: 20, y: 20 },
		new PointerEvent("pointerdown"),
		() => true,
	);
	currentDocument = false;
	selector.dispose();
	vi.advanceTimersByTime(5000);
	expect(handler).not.toHaveBeenCalled();
	expect(r.editor.getState().selection).toBeNull();
});
