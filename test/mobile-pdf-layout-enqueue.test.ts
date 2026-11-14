import { beforeEach, expect, it, vi } from "vitest";
import type { TaskExecutorContext } from "@/lib/core/tasks";
import {
	enqueuePaperLayoutAnalysis,
	registerLayoutTaskExecutor,
} from "@/lib/pdf/layout/enqueue-paper-layout";

const state = vi.hoisted(() => ({
	mobile: true,
	backend: "paddle",
	configured: true,
	cached: false,
	enqueue: vi.fn(async () => ({})),
	focus: vi.fn(async () => ({})),
	headless: vi.fn(async () => ({})),
	executor: null as ((ctx: TaskExecutorContext) => Promise<void>) | null,
}));
vi.mock("@/lib/core/tauri", () => ({
	isMobileApp: () => state.mobile,
	isTauri: () => true,
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		jobLayoutAnalyzeEnqueue: state.enqueue,
		jobFocusPaper: state.focus,
	},
}));
vi.mock("@/lib/core/ipc", () => ({
	callApiResult: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/core/tasks", () => ({
	registerTaskExecutor: (_kind: unknown, executor: typeof state.executor) => {
		state.executor = executor;
	},
}));
vi.mock("@/lib/pdf/layout/headless-analyze", () => ({
	analyzePaperLayoutHeadless: state.headless,
}));
vi.mock("@/lib/pdf/layout/io", () => ({
	readLayoutSidecar: async () =>
		state.cached ? { regions: [{ id: "cached" }] } : null,
	layoutIndexPath: vi.fn(),
	layoutSidecarPath: vi.fn(),
}));
vi.mock("@/lib/pdf/layout/store", () => ({
	layoutAnalysisStore: { subscribe: () => () => {} },
}));
vi.mock("@/lib/settings/store", () => ({
	loadSettings: () => ({
		layout: {
			backend: state.backend,
			providerConfigs: state.configured
				? { paddle: { apiKey: "configured", selfHosted: false, baseUrl: "" } }
				: {},
		},
	}),
}));
vi.mock("@/lib/vault/store", () => ({ getVaultPath: () => "/vault" }));
vi.mock("@/lib/vault", () => ({
	vaultRelativePath: () => "papers/a",
	joinVaultPath: (a: string, b: string) => `${a}/${b}`,
}));
vi.mock("@/lib/paper/media", () => ({ findCanonicalPaperPdfPath: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	state.mobile = true;
	state.backend = "paddle";
	state.configured = true;
	state.cached = false;
});

it("does not enqueue a paid job from automatic open/import even with a configured API", async () => {
	enqueuePaperLayoutAnalysis({
		paperAbsPath: "/vault/papers/a",
		autoTranslate: true,
	});
	await Promise.resolve();
	expect(state.enqueue).not.toHaveBeenCalled();
});

it("requires a remote provider on an explicit mobile action but permits an existing cache", async () => {
	state.backend = "local";
	const onError = vi.fn();
	enqueuePaperLayoutAnalysis({
		paperAbsPath: "/vault/papers/a",
		focus: true,
		onError,
	});
	await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
	expect(state.enqueue).not.toHaveBeenCalled();
	state.cached = true;
	onError.mockClear();
	enqueuePaperLayoutAnalysis({
		paperAbsPath: "/vault/papers/a",
		focus: true,
		onError,
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(onError).not.toHaveBeenCalled();
	expect(state.enqueue).not.toHaveBeenCalled();
});

it("enqueues only the explicitly requested parse and never chains an automatic translation", async () => {
	enqueuePaperLayoutAnalysis({
		paperAbsPath: "/vault/papers/a",
		focus: true,
		autoTranslate: true,
	});
	await vi.waitFor(() => expect(state.focus).toHaveBeenCalledOnce());
	expect(state.enqueue).toHaveBeenCalledWith(
		expect.objectContaining({
			vaultPath: "/vault",
			path: "papers/a",
			lane: "focus",
			autoTranslate: false,
		}),
	);
});

it("passes API-only policy from the shell registration into headless execution on desktop previews", async () => {
	state.mobile = false;
	registerLayoutTaskExecutor({ apiOnly: true });
	const report = vi.fn(async () => {});
	await state.executor?.({
		jobId: "job",
		vaultPath: "/vault",
		paperPath: "papers/a",
		signal: new AbortController().signal,
		report,
	} as unknown as TaskExecutorContext);
	expect(state.headless).toHaveBeenCalledWith(
		expect.objectContaining({ apiOnly: true, paperAbsPath: "/vault/papers/a" }),
	);
	expect(report).toHaveBeenCalledWith(
		expect.objectContaining({ state: "succeeded" }),
	);
});
