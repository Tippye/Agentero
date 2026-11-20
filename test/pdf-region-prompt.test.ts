// @vitest-environment happy-dom
import { Blob as NodeBlob } from "node:buffer";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfInkToolbar } from "@/components/viewer/pdf/chrome/pdf-ink-toolbar";
import {
	type PdfRegionFraming,
	usePdfRegionFraming,
} from "@/components/viewer/pdf/hooks/use-pdf-region-framing";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import { InkController } from "@/lib/pdf/ink/controller";
import { InkEditor } from "@/lib/pdf/ink/editor";
import { inkPointFromClient } from "@/lib/pdf/ink/geometry";

const mocks = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/lib/core/notify", () => ({ notifyError: mocks.notifyError }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
const region = { x: 0.2, y: 0.2, w: 0.5, h: 0.4 };
const size = { width: 500, height: 700 };
const documentObject = (id: string) => ({
	id,
	pages: [{ index: 0, size, rotation: 1, objectNumber: 1 }],
	pageCount: 1,
	normalizedRotation: true,
});
const image = () =>
	new NodeBlob([new Uint8Array([137, 80, 78, 71])], {
		type: "image/png",
	}) as unknown as Blob;
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
let root: Root | null,
	container: HTMLDivElement,
	framing: PdfRegionFraming,
	request: Promise<void> | undefined;
let render: ReturnType<typeof vi.fn>,
	editor: InkEditor,
	apply: ReturnType<typeof vi.fn>;
let documents: Map<string, ReturnType<typeof documentObject>>;
const onPrompt = vi.fn(),
	clear = vi.fn(),
	setSelectionMenu = vi.fn();
let engine: { renderPageRect: ReturnType<typeof vi.fn> };
let docCap: {
	isDocumentOpen(id: string): boolean;
	getDocument(id: string): ReturnType<typeof documentObject> | undefined;
};
function Harness({
	docId = "old",
	callback = true,
}: {
	docId?: string;
	callback?: boolean;
}) {
	framing = usePdfRegionFraming({
		docId,
		engine: engine as never,
		docCap: docCap as never,
		selectionCap: { clear } as never,
		interactionCap: null,
		setSelectionMenu,
		onRegionPrompt: callback ? onPrompt : undefined,
	});
	return createElement(PdfInkToolbar, {
		editor,
		editable: true,
		cropPending: framing.visualCropPending,
		pageSize: () => size,
		onAskRegion: callback
			? (page, bounds) => {
					request = framing.beginRegionPrompt(page, bounds);
					return request;
				}
			: undefined,
	});
}
function lassoFigure() {
	const page = { page: 1, ...size, rotation: 1, element: container };
	const box = { left: 10, top: 20, width: 1050, height: 750 };
	const samples = [
		[100, 140],
		[350, 140],
		[350, 420],
		[100, 420],
	].map(([x, y]) => ({
		...inkPointFromClient(
			{ x: box.left + (size.height - y) * 1.5, y: box.top + x * 1.5 },
			box,
			page,
		),
		pressure: null,
		elapsedMs: null,
		tilt: null,
	}));
	editor.setMode("lasso");
	editor.begin(page, samples[0]);
	editor.append(samples.slice(1));
	editor.finish();
}
const askButton = () =>
	container.querySelector<HTMLButtonElement>(
		'button[aria-label="ink.askRegion"]',
	);
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	request = undefined;
	documents = new Map([
		["old", documentObject("old")],
		["new", documentObject("new")],
	]);
	docCap = {
		isDocumentOpen: (id) => documents.has(id),
		getDocument: (id) => documents.get(id),
	};
	render = vi.fn(() => ({ toPromise: async () => image() }));
	engine = { renderPageRect: render };
	apply = vi.fn();
	const controller = new InkController({
		read: async () => ({
			document: { version: 1, page: 1, strokes: [], tombstones: [] },
			revision: null,
			creationTimes: {},
			updateTimes: {},
		}),
		apply,
	});
	await controller.load(1);
	editor = new InkEditor(controller);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() => root?.render(createElement(Harness)));
});
afterEach(async () => {
	await act(() => root?.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("lasso to reviewed source-PDF context draft", () => {
	it("allows zero selected strokes on a zoomed rotated visible crop, disarms ink and emits one draft without mark writes", async () => {
		await act(() => lassoFigure());
		expect(editor.getState().selection?.ids).toEqual([]);
		expect(editor.getState().selection?.bounds).toEqual({
			x: 100,
			y: 140,
			width: 250,
			height: 280,
		});
		expect(askButton()?.className).toContain("min-h-11");
		const pending = deferred<Blob>();
		render.mockReturnValue({ toPromise: () => pending.promise });
		await act(() => {
			const button = askButton();
			button?.click();
			button?.click();
		});
		expect(render).toHaveBeenCalledOnce();
		expect(editor.getState().mode).toBe("read");
		expect(editor.getState().selection).toBeNull();
		expect(framing.visualCropPending).toBe(true);
		expect(askButton()?.disabled).toBe(true);
		expect(render.mock.calls[0][2]).toEqual({
			origin: { x: 100, y: 140 },
			size: { width: expect.closeTo(250, 8), height: expect.closeTo(280, 8) },
		});
		expect(render.mock.calls[0][3]).toMatchObject({
			withAnnotations: false,
			withForms: false,
			imageType: "image/png",
		});
		await act(async () => {
			pending.resolve(image());
			await request;
		});
		expect(onPrompt).toHaveBeenCalledOnce();
		expect(onPrompt).toHaveBeenCalledWith({
			page: 1,
			region: {
				x: 0.2,
				y: 0.2,
				w: expect.closeTo(0.5, 10),
				h: expect.closeTo(0.4, 10),
			},
			image: { data: "iVBORw==", mimeType: "image/png" },
		});
		expect(apply).not.toHaveBeenCalled();
		expect(framing.visualCropPending).toBe(false);
	});

	it("shows Ask only when its callback, a valid region and a clean loaded baseline all exist", async () => {
		await act(() => lassoFigure());
		expect(askButton()).not.toBeNull();
		await act(() => root?.render(createElement(Harness, { callback: false })));
		expect(askButton()).toBeNull();
		await act(() => root?.render(createElement(Harness)));
		expect(askButton()).not.toBeNull();
		await act(() => editor.controller.setDrawing(true));
		expect(askButton()).toBeNull();
		await act(() => editor.controller.setDrawing(false));
		expect(askButton()).not.toBeNull();
		await act(() => {
			editor.setMode("lasso");
			const point = {
				x: 10,
				y: 10,
				pressure: null,
				tilt: null,
				elapsedMs: null,
			};
			editor.begin(
				{ page: 1, ...size, rotation: 0, element: container },
				point,
			);
			editor.append([{ ...point, x: 11, y: 11 }]);
			editor.finish();
		});
		expect(askButton()).toBeNull();
		expect(onPrompt).not.toHaveBeenCalled();
	});

	it("drops old-document completion even while that document remains open, without releasing a newer crop guard", async () => {
		const old = deferred<Blob>(),
			next = deferred<Blob>();
		render
			.mockReturnValueOnce({ toPromise: () => old.promise })
			.mockReturnValueOnce({ toPromise: () => next.promise });
		let oldRequest!: Promise<void>, nextRequest!: Promise<void>;
		await act(() => {
			oldRequest = framing.beginRegionPrompt(1, region);
		});
		await act(() => root?.render(createElement(Harness, { docId: "new" })));
		await act(() => {
			nextRequest = framing.beginRegionPrompt(1, region);
		});
		await act(async () => {
			old.resolve(image());
			await oldRequest;
		});
		expect(docCap.isDocumentOpen("old")).toBe(true);
		expect(onPrompt).not.toHaveBeenCalled();
		expect(framing.visualCropPending).toBe(true);
		await act(() => framing.beginRegionPrompt(1, region));
		expect(render).toHaveBeenCalledTimes(2);
		await act(async () => {
			next.resolve(image());
			await nextRequest;
		});
		expect(onPrompt).toHaveBeenCalledOnce();
		expect(framing.visualCropPending).toBe(false);
	});

	it("drops a crop when its document object was replaced under the same ID or the viewer unmounts", async () => {
		const first = deferred<Blob>();
		render.mockReturnValue({ toPromise: () => first.promise });
		let pending!: Promise<void>;
		await act(() => {
			pending = framing.beginRegionPrompt(1, region);
		});
		documents.set("old", documentObject("old"));
		await act(async () => {
			first.resolve(image());
			await pending;
		});
		expect(onPrompt).not.toHaveBeenCalled();
		const second = deferred<Blob>();
		render.mockReturnValue({ toPromise: () => second.promise });
		await act(() => {
			pending = framing.beginRegionPrompt(1, region);
		});
		await act(() => root?.unmount());
		root = null;
		second.resolve(image());
		await pending;
		expect(onPrompt).not.toHaveBeenCalled();
		expect(mocks.notifyError).not.toHaveBeenCalled();
	});

	it("reports a 1-based page while rendering the corresponding zero-based PDF page", async () => {
		const document = documents.get("old");
		document?.pages.push({ index: 1, size, rotation: 1, objectNumber: 2 });
		await act(() => framing.beginRegionPrompt(2, region));
		expect(render.mock.calls[0][1].index).toBe(1);
		expect(onPrompt.mock.calls[0][0].page).toBe(2);
	});

	it("keeps framed regions on the prompt destination only", async () => {
		// A drawn region never creates a note / visual mark: the removed
		// onVisualDraft + beginVisualAnnotation chain must not come back.
		expect(Object.keys(framing).sort()).toEqual([
			"beginRegionPrompt",
			"regionSelecting",
			"toggleRegionSelect",
			"visualCropPending",
			"visualCropRegion",
		]);
		await act(() => framing.beginRegionPrompt(1, region));
		expect(onPrompt).toHaveBeenCalledOnce();
	});

	it("reports crop failure without emitting a draft, then releases the guard for an explicit retry", async () => {
		render.mockReturnValueOnce({
			toPromise: async () => {
				throw new Error("renderer failed");
			},
		});
		await act(() => framing.beginRegionPrompt(1, region));
		expect(onPrompt).not.toHaveBeenCalled();
		expect(framing.visualCropPending).toBe(false);
		expect(mocks.notifyError).toHaveBeenCalledWith("pdfExplain.cropFailed", {
			description: "renderer failed",
		});
		await act(() => framing.beginRegionPrompt(1, region));
		expect(onPrompt).toHaveBeenCalledOnce();
	});

	it("caps the generated crop below 1600px for very large poster pages", async () => {
		const poster = {
			...documentObject("poster"),
			pages: [
				{
					index: 0,
					rotation: 0,
					objectNumber: 1,
					size: { width: 20000, height: 10000 },
				},
			],
		};
		await renderPdfRegionPromptImage({
			engine: engine as never,
			document: poster as never,
			pageIndex: 0,
			region: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
		});
		const [, , rect, options] = render.mock.calls[0];
		expect(options.scaleFactor).toBe(0.1);
		expect(
			Math.max(rect.size.width, rect.size.height) * options.scaleFactor,
		).toBe(1600);
	});
});
