// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useMobilePdfProcessingRuntime } from "@/lib/mobile/pdf-processing";
import { isApiOnlyPdfProcessing } from "@/lib/pdf/processing-policy";

const state = vi.hoisted(() => ({
	registerLayout: vi.fn(),
	registerTranslate: vi.fn(),
	stop: vi.fn(),
	start: vi.fn(),
}));
vi.mock("@/lib/core/tauri", () => ({ isMobileApp: () => false }));
vi.mock("@/lib/core/tasks", () => ({
	startTaskRuntime: () => {
		state.start();
		return state.stop;
	},
}));
vi.mock("@/lib/pdf/layout/enqueue-paper-layout", () => ({
	registerLayoutTaskExecutor: state.registerLayout,
}));
vi.mock("@/lib/pdf/layout/headless-translate", () => ({
	registerLayoutTranslateTaskExecutor: state.registerTranslate,
}));

it("owns the task listener and API-only policy at the app boundary across reader close/reopen", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Shell() {
		useMobilePdfProcessingRuntime();
		const [reader, setReader] = useState(true);
		return createElement(
			"button",
			{ type: "button", onClick: () => setReader(!reader) },
			reader ? "reader" : "library",
		);
	}
	try {
		expect(isApiOnlyPdfProcessing()).toBe(false);
		await act(() => root.render(createElement(Shell)));
		expect(isApiOnlyPdfProcessing()).toBe(true);
		expect(state.registerLayout).toHaveBeenCalledWith({ apiOnly: true });
		expect(state.registerTranslate).toHaveBeenCalledWith({ apiOnly: true });
		await act(() => host.querySelector("button")?.click());
		expect(host.textContent).toBe("library");
		expect(state.stop).not.toHaveBeenCalled();
		await act(() => host.querySelector("button")?.click());
		expect(state.start).toHaveBeenCalledOnce();
		expect(isApiOnlyPdfProcessing()).toBe(true);
	} finally {
		await act(() => root.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
	expect(state.stop).toHaveBeenCalledOnce();
	expect(isApiOnlyPdfProcessing()).toBe(false);
});
