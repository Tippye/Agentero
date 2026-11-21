// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfViewerCapabilities } from "@/components/viewer/pdf/capabilities";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { usePdfLayoutRun } from "@/components/viewer/pdf/hooks/use-pdf-layout-run";

const mocks = vi.hoisted(() => ({
	mobile: false,
	enqueue: vi.fn(),
	run: vi.fn(),
	read: vi.fn(),
	publish: vi.fn(),
	chat: vi.fn(),
	force: vi.fn().mockResolvedValue(undefined),
	onLayoutWrite: null as ((path: string) => void) | null,
	quickChatArmed: undefined as (() => boolean) | undefined,
}));
vi.mock("@/lib/core/tauri", () => ({
	isMobileApp: () => mocks.mobile,
	isTauri: () => false,
}));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/core/tasks", () => ({ runLocalActivity: vi.fn() }));
vi.mock("@/lib/shell/settings-window", () => ({ openSettingsWindow: vi.fn() }));
vi.mock("@/lib/pdf/layout/enqueue-paper-layout", () => ({
	forcePaperLayoutAnalysis: mocks.force,
}));
vi.mock("@/lib/pdf/layout/io", async (original) => ({
	...(await original<typeof import("@/lib/pdf/layout/io")>()),
	subscribeLayoutSidecarWrite: (listener: (path: string) => void) => {
		mocks.onLayoutWrite = listener;
		return () => {
			mocks.onLayoutWrite = null;
		};
	},
}));
vi.mock("@/lib/vault/file-change-gate", () => ({
	listenVaultFileChangedGated: vi.fn(),
}));
vi.mock("@/lib/pdf/layout", () => ({
	enqueuePaperLayoutAnalysis: mocks.enqueue,
	runDocumentLayoutAnalysis: mocks.run,
	readLayoutSidecar: mocks.read,
	getLayoutDocumentResult: () => null,
	layoutDocumentKey: (id: string) => id,
	mergeCaptionsIntoHosts: (regions: unknown[]) => regions,
	buildLayoutDocumentResult: (
		documentId: string,
		regions: unknown[],
		rawRegions: unknown[],
	) => ({ documentId, regions, rawRegions }),
	setLayoutDocumentResult: mocks.publish,
	setLayoutOverlayVisible: vi.fn(),
	layoutAnalysisStore: { subscribe: () => () => {} },
}));
vi.mock("@/components/selection/add-selection-to-chat", () => ({
	addSelectionToChat: mocks.chat,
}));
vi.mock("@/components/selection/use-selection-quick-chat", () => ({
	useSelectionQuickChat: (armed: () => boolean) => {
		mocks.quickChatArmed = armed;
	},
}));
vi.mock("@/lib/shell/commands/menu-contributions", () => ({
	visibleMenuContributions: () => [],
	activateMenuContribution: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.mobile = false;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("PDF viewer host capabilities", () => {
	it("keeps desktop behavior by default and detects mobile, including an explicit preview runtime", () => {
		expect(Object.values(pdfViewerCapabilities()).every(Boolean)).toBe(true);
		mocks.mobile = true;
		expect(pdfViewerCapabilities()).toMatchObject({
			apiOnly: true,
			layoutAnalysis: true,
			layoutTranslation: true,
			ask: false,
			latex: false,
			smartHighlights: false,
		});
		expect(pdfViewerCapabilities("desktop").ask).toBe(true);
		mocks.mobile = false;
		expect(pdfViewerCapabilities("mobile").apiOnly).toBe(true);
	});

	it("renders the mobile selection palette and notes without desktop chat actions", () => {
		const capabilities = pdfViewerCapabilities("mobile");
		const html = renderToStaticMarkup(
			createElement(SelectionMenu, {
				screen: { x: 100, y: 100 },
				onHighlight: vi.fn(),
				onNote: vi.fn(),
				onCopy: vi.fn(),
				onTranslate: vi.fn(),
				onAsk: capabilities.ask ? vi.fn() : undefined,
				onAddToChat: capabilities.addToChat ? vi.fn() : undefined,
			}),
		);
		// Upstream 0.17.0 SelectionToolbarIconButton appends the keyboard shortcut
		// to the aria-label (e.g. "selection.note N"), matching the copy button.
		expect(html).toContain('aria-label="selection.note N"');
		expect(html).toContain('aria-label="selection.copy ');
		expect(html).toContain('aria-label="selection.translate T"');
		expect(html).not.toContain("selection.addToChat");
		expect(html).not.toContain("selection.chatActions");
	});

	it("only enqueues mobile parsing after a manual action, keeping the job outside reader teardown", async () => {
		const regions = [{ id: "synced", pageIndex: 0, kind: "image" }];
		mocks.read.mockResolvedValue({
			source: { generatedAt: "mobile-new" },
			regions,
		});
		let layout: ReturnType<typeof usePdfLayoutRun> | undefined;
		const docs = { isDocumentOpen: () => true };
		function Harness() {
			layout = usePdfLayoutRun({
				canAnalyze: true,
				apiOnly: pdfViewerCapabilities("mobile").apiOnly,
				docId: "api-only-layout",
				paperAbsPath: "/vault/papers/a",
				paperRelPath: "papers/a",
				isActive: true,
				totalPages: 1,
				layoutCap: null,
				layoutCapRef: { current: null },
				docCap: docs as never,
				docCapRef: { current: docs as never },
			});
			return null;
		}
		await act(() => root.render(createElement(Harness)));
		expect(mocks.publish).toHaveBeenCalled();
		expect(mocks.enqueue).not.toHaveBeenCalled();
		expect(mocks.run).not.toHaveBeenCalled();
		await act(() =>
			layout?.startLayoutAnalysisRef.current({ showOverlay: true }),
		);
		expect(mocks.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				paperAbsPath: "/vault/papers/a",
				focus: true,
				apiOnly: true,
			}),
		);
		await act(() => layout?.startLayoutAnalysisRef.current({ force: true }));
		expect(mocks.force).toHaveBeenCalledWith(
			expect.objectContaining({ apiOnly: true }),
		);
		expect(layout?.layoutTaskRef.current).toBeNull();
		const completedRegions = [
			{ id: "headless-result", pageIndex: 0, kind: "image" },
		];
		mocks.read.mockResolvedValue({
			source: { generatedAt: "headless-finished" },
			regions: completedRegions,
		});
		await act(() => mocks.onLayoutWrite?.("/vault/papers/a"));
		expect(mocks.publish).toHaveBeenLastCalledWith(
			expect.objectContaining({ regions: completedRegions }),
		);
		expect(mocks.enqueue).toHaveBeenCalledOnce();
		await act(() => root.render(null));
		expect(mocks.onLayoutWrite).toBeNull();
		expect(mocks.run).not.toHaveBeenCalled();
	});

	it("loads synced layout without an analysis capability, enqueue, or inference, even on a manual rerun", async () => {
		const regions = [{ id: "synced-figure", pageIndex: 0, kind: "image" }];
		mocks.read.mockResolvedValue({
			source: { generatedAt: "2026-11-11T00:00:00Z" },
			regions,
		});
		let layout: ReturnType<typeof usePdfLayoutRun> | undefined;
		const docs = { isDocumentOpen: () => true };
		function Harness() {
			layout = usePdfLayoutRun({
				canAnalyze: false,
				docId: "mobile-layout",
				paperAbsPath: "/vault/papers/a",
				paperRelPath: "papers/a",
				isActive: true,
				totalPages: 1,
				layoutCap: null,
				layoutCapRef: { current: null },
				docCap: docs as never,
				docCapRef: { current: docs as never },
			});
			return null;
		}
		await act(() => root.render(createElement(Harness)));
		layout?.startLayoutAnalysisRef.current({
			force: true,
			asBackgroundTask: true,
		});
		expect(mocks.read).toHaveBeenCalledWith("/vault/papers/a");
		expect(mocks.publish).toHaveBeenCalledWith({
			documentId: "mobile-layout",
			regions,
			rawRegions: regions,
		});
		expect(mocks.enqueue).not.toHaveBeenCalled();
		expect(mocks.run).not.toHaveBeenCalled();
	});
});
