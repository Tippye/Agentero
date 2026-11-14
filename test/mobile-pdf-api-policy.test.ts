import type { LayoutAnalysisScope } from "@embedpdf/plugin-layout-analysis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPdfAiRuntime } from "@/lib/pdf/layout/ai-runtime";
import { runLayoutRegionTranslate } from "@/lib/pdf/layout/layout-translate";
import { runLayoutRegionTranslate as runPublicLayoutRegionTranslate } from "@/lib/pdf/layout/layout-translate-reliable";
import { runDocumentLayoutAnalysis } from "@/lib/pdf/layout/run-analysis";
import { enterApiOnlyPdfProcessing } from "@/lib/pdf/processing-policy";
import { runTranslate } from "@/lib/translate/run";

const state = vi.hoisted(() => ({
	mobile: false,
	provider: "agent",
	backend: "local",
	configs: {} as Record<string, unknown>,
	cache: null as unknown,
	ensure: vi.fn(),
	localRuntime: vi.fn(),
	remote: vi.fn(),
	publish: vi.fn(),
	service: vi.fn(async (task: { result?: string }) => {
		task.result = "translated";
	}),
	agent: vi.fn(),
}));
vi.mock("@/i18n", () => ({
	default: { t: (key: string) => key, language: "en" },
}));
vi.mock("@/lib/core/tauri", () => ({
	isMobileApp: () => state.mobile,
	isTauri: () => false,
}));
const settings = () => ({
	layout: { backend: state.backend, providerConfigs: state.configs },
	translate: {
		provider: state.provider,
		providerConfigs: state.configs,
		sourceLang: "auto",
		targetLang: "zh-CN",
	},
});
vi.mock("@/lib/settings", () => ({ loadSettings: () => settings() }));
vi.mock("@/lib/settings/store", () => ({ loadSettings: () => settings() }));
vi.mock("@/lib/pdf/layout/io", async (original) => ({
	...(await original<typeof import("@/lib/pdf/layout/io")>()),
	readLayoutSidecar: vi.fn(async () => state.cache),
	writeLayoutIndexFromRaw: vi.fn(async () => {}),
	writeLayoutSidecar: vi.fn(async () => {}),
}));
vi.mock("@/lib/paper", () => ({
	findCanonicalPaperPdfPath: async () => "/vault/papers/a/a.pdf",
	localFileToArrayBuffer: async () => new ArrayBuffer(8),
}));
vi.mock("@/lib/pdf/layout/model", () => ({
	ensureLayoutModel: state.ensure,
	layoutModelLocalUrl: () => "model://local",
}));
vi.mock("@embedpdf/ai/web", () => ({ createAiRuntime: state.localRuntime }));
vi.mock("@/lib/pdf/layout/store", () => ({
	setLayoutAnalysisUi: vi.fn(),
	setLayoutDocumentResult: state.publish,
}));
vi.mock("@/lib/pdf/layout/paddle", () => ({
	invokeLayoutRemoteAnalyzePdf: state.remote,
	paddlePageToRegions: vi.fn(),
}));
vi.mock("@/lib/translate/services", () => ({
	getTranslateService: () => ({ translate: state.service }),
	isCommercialTranslateProvider: (id: string) =>
		["deepl", "azure", "googleCloud", "openaiCompatible"].includes(id),
}));
vi.mock("@/lib/translate/resolve-agent", () => ({
	resolveConfiguredTranslateAgent: state.agent,
}));
vi.mock("@/lib/agent", () => ({
	runOnce: state.agent,
	listenAgentCompleted: vi.fn(),
	listenAgentFailed: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
	state.mobile = false;
	state.provider = "agent";
	state.backend = "local";
	state.configs = {};
	state.cache = null;
});

const scope = () =>
	({
		analyzeAllPages: vi.fn(),
		getPageLayout: vi.fn(),
		getPageTextRuns: vi.fn(),
	}) as unknown as LayoutAnalysisScope;

describe("mobile PDF API-only execution boundaries", () => {
	it("fails closed before local model ensure or remote upload with stale desktop settings", async () => {
		const local = scope();
		await expect(
			runDocumentLayoutAnalysis(local, "doc", {
				apiOnly: true,
				paperAbsPath: "/vault/papers/a",
				totalPages: 1,
			}),
		).rejects.toThrow("layoutProviderRequired");
		expect(state.ensure).not.toHaveBeenCalled();
		expect(local.analyzeAllPages).not.toHaveBeenCalled();
		expect(state.remote).not.toHaveBeenCalled();
		state.backend = "paddle";
		await expect(
			runDocumentLayoutAnalysis(local, "doc", {
				apiOnly: true,
				paperAbsPath: "/vault/papers/a",
				totalPages: 1,
			}),
		).rejects.toThrow("layoutProviderRequired");
		state.configs = {
			paddle: { apiKey: "configured", baseUrl: "", selfHosted: false },
		};
		await expect(
			runDocumentLayoutAnalysis(local, "doc", {
				apiOnly: true,
				paperAbsPath: "/vault/papers/a",
			}),
		).rejects.toThrow("layoutProviderRequired");
		expect(state.ensure).not.toHaveBeenCalled();
		expect(state.remote).not.toHaveBeenCalled();
	});

	it("runs an explicitly configured remote API without invoking local inference", async () => {
		state.backend = "paddle";
		state.configs = {
			paddle: { apiKey: "configured", baseUrl: "", selfHosted: false },
		};
		state.remote.mockResolvedValue({ pages: [] });
		const local = scope();
		const onDone = vi.fn();
		await runDocumentLayoutAnalysis(local, "remote", {
			apiOnly: true,
			paperAbsPath: "/vault/papers/a",
			totalPages: 1,
			onDone,
		});
		await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
		expect(state.remote).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "paddle" }),
		);
		expect(state.ensure).not.toHaveBeenCalled();
		expect(local.analyzeAllPages).not.toHaveBeenCalled();
	});

	it("loads a cached parse with local settings without model initialization or text backfill", async () => {
		state.cache = {
			schemaVersion: 3,
			source: { mode: "embedpdf-layout", generatedAt: "saved" },
			regions: [],
		};
		const local = scope();
		await expect(
			runDocumentLayoutAnalysis(local, "cached", {
				apiOnly: true,
				paperAbsPath: "/vault/papers/a",
				totalPages: 1,
			}),
		).resolves.toBeNull();
		expect(state.publish).toHaveBeenCalled();
		expect(local.getPageTextRuns).not.toHaveBeenCalled();
		expect(state.ensure).not.toHaveBeenCalled();
	});

	it("rejects Agent before resolving ACP in bulk translation while retaining complete cached blocks", async () => {
		const item = {
			id: "one",
			pageIndex: 0,
			bbox: { x: 0, y: 0, w: 1, h: 1 },
			kind: "text" as const,
			readingOrder: 0,
			source: "Source sentence.",
			status: "pending" as const,
		};
		await expect(
			runLayoutRegionTranslate({
				apiOnly: true,
				items: [item],
				onUpdate: vi.fn(),
			}),
		).rejects.toThrow("translateProviderRequired");
		expect(state.agent).not.toHaveBeenCalled();
		expect(state.service).not.toHaveBeenCalled();
		const publicResult = await runPublicLayoutRegionTranslate({
			apiOnly: true,
			items: [item],
			onUpdate: vi.fn(),
		});
		expect(publicResult[0]).toMatchObject({
			status: "error",
			error: expect.stringContaining("translateProviderRequired"),
		});
		expect(state.agent).not.toHaveBeenCalled();
		const cached = { ...item, status: "done" as const, translated: "已完成。" };
		await expect(
			runLayoutRegionTranslate({
				apiOnly: true,
				items: [cached],
				onUpdate: vi.fn(),
			}),
		).resolves.toEqual([cached]);
		expect(state.agent).not.toHaveBeenCalled();
	});

	it("enforces mobile-shell policy for shared translation and never initializes an ONNX runtime", async () => {
		const release = enterApiOnlyPdfProcessing();
		try {
			await expect(
				runTranslate(
					{ text: "selection" },
					{ agent: { runOnce: state.agent } },
				),
			).rejects.toThrow("translateProviderRequired");
			const runtime = getPdfAiRuntime();
			expect(() => runtime.loadModel("layout-detection")).toThrow(
				"layoutProviderRequired",
			);
			expect(state.localRuntime).not.toHaveBeenCalled();
			state.provider = "openaiCompatible";
			await expect(runTranslate({ text: "selection" })).rejects.toThrow(
				"translateProviderRequired",
			);
			state.provider = "googleapi";
			await expect(runTranslate({ text: "selection" })).resolves.toBe(
				"translated",
			);
		} finally {
			release();
			release();
		}
		expect(state.service).toHaveBeenCalledOnce();
		expect(state.agent).not.toHaveBeenCalled();
	});
});
