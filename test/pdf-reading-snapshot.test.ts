// @vitest-environment happy-dom
import { createBehaviorEmitter } from "@embedpdf/core";
import type { LayoutReadyEvent } from "@embedpdf/plugin-scroll";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePdfNavigation } from "@/components/viewer/pdf/hooks/use-pdf-navigation";
import {
	normalizePdfReadingSnapshot,
	type PdfReadingSnapshot,
	type PdfReadingSnapshotSeed,
	seedPdfReadingSnapshot,
} from "@/lib/pdf/reading-position";

const mocks = vi.hoisted(() => ({ capability: null as unknown }));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
	useScrollCapability: () => ({ provides: mocks.capability }),
}));
let root: Root,
	ready: ReturnType<typeof createBehaviorEmitter<LayoutReadyEvent>>;
let frameId: number,
	frames: Map<number, FrameRequestCallback>,
	page: number,
	zoom: number;
let scrollEvents: Set<() => void>, zoomEvents: Set<() => void>;
let scope: {
	getMetrics: () => object;
	scrollToPage: ReturnType<typeof vi.fn>;
	onScroll: ReturnType<typeof vi.fn>;
};
let zoomRef: { current: unknown }, scrollRef: { current: unknown };
const docCapRef = {
	current: {
		getDocumentState: () => ({
			rotation: 0,
			document: {
				pages: Array.from({ length: 20 }, () => ({
					size: { width: 600, height: 800 },
					rotation: 0,
				})),
			},
		}),
	},
};
const callback = vi.fn();
function Viewer({
	base = "paper-a",
	revision = "r1",
	initial = { page: 6, zoom: 1.8 },
	changed = callback,
}: {
	base?: string;
	revision?: string;
	initial?: PdfReadingSnapshot;
	changed?: typeof callback;
}) {
	const seed = useRef<PdfReadingSnapshotSeed | null>(null);
	seed.current = seedPdfReadingSnapshot(seed.current, base, initial);
	usePdfNavigation({
		docId: `${base}::${revision}`,
		baseDocId: base,
		paperKey: null,
		currentPage: page,
		totalPages: 20,
		scroll: scope as never,
		scrollRef: scrollRef as never,
		docCapRef: docCapRef as never,
		zoomRef: zoomRef as never,
		reloadPositionRef: seed.current.position,
		onReadingSnapshotChange: changed,
	});
	return null;
}
const emitScroll = () => {
	for (const fn of scrollEvents) fn();
};
const layout = (base = "paper-a", revision = "r1") =>
	ready.emit({
		documentId: `${base}::${revision}`,
		totalPages: 20,
		pageNumber: 1,
		isInitial: true,
	});
function frame() {
	const next = [...frames.values()];
	frames.clear();
	for (const fn of next) fn(0);
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	page = 1;
	zoom = 1;
	frameId = 0;
	frames = new Map();
	scrollEvents = new Set();
	zoomEvents = new Set();
	callback.mockClear();
	vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
		frames.set(++frameId, fn);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	ready = createBehaviorEmitter<LayoutReadyEvent>();
	scope = {
		getMetrics: () => ({
			currentPage: page,
			pageVisibilityMetrics: [
				{
					pageNumber: page,
					original: { pageX: 0, pageY: 0 },
					viewportX: 0,
					viewportY: 0,
				},
			],
		}),
		scrollToPage: vi.fn(),
		onScroll: vi.fn((fn: () => void) => {
			scrollEvents.add(fn);
			return () => {
				scrollEvents.delete(fn);
			};
		}),
	};
	zoomRef = {
		current: {
			getState: () => ({ currentZoomLevel: zoom }),
			requestZoom: vi.fn((value: number) => {
				zoom = value;
				for (const fn of zoomEvents) fn();
			}),
			onZoomChange: (fn: () => void) => {
				zoomEvents.add(fn);
				return () => {
					zoomEvents.delete(fn);
				};
			},
		},
	};
	scrollRef = { current: scope };
	mocks.capability = { onLayoutReady: ready.on, forDocument: () => scope };
	root = createRoot(document.createElement("div"));
});
afterEach(async () => {
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});
it("normalizes finite snapshots and never reseeds a live paper from new prop objects", () => {
	expect(normalizePdfReadingSnapshot({ page: 3.9, zoom: 99 })).toEqual({
		page: 3,
		zoom: 3,
	});
	expect(normalizePdfReadingSnapshot({ page: 2, zoom: 0.1 })).toEqual({
		page: 2,
		zoom: 0.5,
	});
	expect(normalizePdfReadingSnapshot({ page: Infinity, zoom: 1 })).toBeNull();
	expect(normalizePdfReadingSnapshot({ page: 1, zoom: NaN })).toBeNull();
	const first = seedPdfReadingSnapshot(null, "a", { page: 6, zoom: 1.8 });
	first.position.current = {
		documentId: "a::physical-revision",
		page: 9,
		zoom: 2,
		x: 21,
		y: 42,
		alignX: 10,
		alignY: 20,
	};
	const same = seedPdfReadingSnapshot(first, "a", { page: 1, zoom: 1 });
	expect(same).toBe(first);
	expect(same.position.current?.page).toBe(9);
	const next = seedPdfReadingSnapshot(first, "b", { page: 4, zoom: 1.2 });
	expect(next.position).not.toBe(first.position);
	first.position.current = {
		...first.position.current,
		page: 15,
	} as NonNullable<typeof first.position.current>;
	expect(next.position.current).toMatchObject({
		documentId: "b::initial-reading-snapshot",
		page: 4,
		zoom: 1.2,
		x: 0,
		y: 0,
		alignX: 0,
		alignY: 0,
	});
});
it("restores zoom before page after layout, and never publishes default metrics while the viewport scroll is pending", async () => {
	await act(() => root.render(createElement(Viewer)));
	await act(() => emitScroll());
	expect(callback).not.toHaveBeenCalled();
	expect(scope.scrollToPage).not.toHaveBeenCalled();
	await act(() => layout());
	expect(zoom).toBe(1.8);
	await act(() => {
		frame();
		frame();
	});
	expect(scope.scrollToPage).not.toHaveBeenCalled();
	await act(() => frame());
	expect(scope.scrollToPage).toHaveBeenCalledExactlyOnceWith({
		pageNumber: 6,
		pageCoordinates: { x: 0, y: 0 },
		alignX: 0,
		alignY: 0,
		behavior: "instant",
	});
	await act(() => emitScroll());
	expect(callback).not.toHaveBeenCalled();
	page = 6;
	await act(() => emitScroll());
	expect(callback).toHaveBeenCalledExactlyOnceWith(
		{ page: 6, zoom: 1.8 },
		"paper-a",
	);
});
it("uses the latest callback without re-registering or reseeding and retains physical reload position", async () => {
	await act(() => root.render(createElement(Viewer)));
	await act(() => {
		layout();
		frame();
		frame();
		frame();
	});
	page = 6;
	await act(() => emitScroll());
	const latest = vi.fn();
	await act(() =>
		root.render(
			createElement(Viewer, {
				initial: { page: 2, zoom: 0.8 },
				changed: latest,
			}),
		),
	);
	expect(scope.onScroll).toHaveBeenCalledTimes(1);
	page = 8;
	zoom = 2;
	await act(() => emitScroll());
	expect(latest).toHaveBeenCalledExactlyOnceWith(
		{ page: 8, zoom: 2 },
		"paper-a",
	);
	scope.scrollToPage.mockClear();
	await act(() =>
		root.render(
			createElement(Viewer, {
				revision: "r2",
				initial: { page: 2, zoom: 0.8 },
				changed: latest,
			}),
		),
	);
	await act(() => {
		layout("paper-a", "r2");
		frame();
		frame();
		frame();
	});
	expect(scope.scrollToPage).toHaveBeenLastCalledWith(
		expect.objectContaining({ pageNumber: 8 }),
	);
	expect(zoom).toBe(2);
});
it("fences old-paper cleanup with its captured base identity and resets the new paper restore gate", async () => {
	await act(() => root.render(createElement(Viewer)));
	await act(() => {
		layout();
		frame();
		frame();
		frame();
	});
	page = 6;
	await act(() => emitScroll());
	const latest = vi.fn();
	await act(() =>
		root.render(
			createElement(Viewer, {
				base: "paper-b",
				initial: { page: 3, zoom: 1.2 },
				changed: latest,
			}),
		),
	);
	expect(latest.mock.calls.every(([, base]) => base === "paper-a")).toBe(true);
	latest.mockClear();
	page = 1;
	zoom = 1;
	await act(() => emitScroll());
	expect(latest).not.toHaveBeenCalled();
	await act(() => {
		layout("paper-b");
		frame();
		frame();
		frame();
	});
	expect(scope.scrollToPage).toHaveBeenLastCalledWith(
		expect.objectContaining({ pageNumber: 3 }),
	);
	page = 3;
	await act(() => emitScroll());
	expect(latest).toHaveBeenCalledExactlyOnceWith(
		{ page: 3, zoom: 1.2 },
		"paper-b",
	);
});
