// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/lib/settings/types";

const io = vi.hoisted(() => ({
	save: vi.fn(),
	error: vi.fn(),
	agent: vi.fn(),
	probe: vi.fn(),
	clear: vi.fn(),
	snapshot: null as AppSettings | null,
	t: (key: string) => key,
}));
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: io.t }),
}));
vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => true,
	isMobileApp: () => true,
	isMacOS: () => false,
}));
vi.mock("@/lib/core/notify", () => ({
	notifyError: io.error,
	notifySuccess: vi.fn(),
	errorMessage: (e: unknown) => String(e),
}));
vi.mock("@/lib/settings", () => ({
	loadSettings: () => io.snapshot,
	saveSettingsAsync: io.save,
	subscribeSettings: () => () => {},
}));
vi.mock("@/lib/agent", () => ({
	listAgents: io.agent,
	warmAgent: io.agent,
	listenAgentModels: io.agent,
	loadModelCatalog: io.agent,
	saveModelCatalog: io.agent,
}));
vi.mock("@/lib/paper/reparse", () => ({
	clearParseResults: io.clear,
	clearAndReparse: io.clear,
}));
vi.mock("@/lib/pdf/layout/paddle", () => ({
	invokeLayoutRemoteProbe: io.probe,
	tinyProbeJpegBase64: () => "jpeg",
}));
vi.mock("@/lib/translate", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/translate")>()),
	probeCommercialMtProvider: io.probe,
	probeFreeMtProviders: io.probe,
}));

import { MobileProcessingSettings } from "@/components/mobile/mobile-processing-settings";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openMobileProcessingSettings } from "@/lib/mobile/processing-settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
async function change(id: string, value: string) {
	await act(async () => {
		const field = input(id);
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function confirm(id: string) {
	const card =
		input(id).closest('[data-slot="provider-card"]') ??
		input(id).closest("section") ??
		input(id).parentElement?.parentElement?.parentElement;
	const button = [...(card?.querySelectorAll("button") ?? [])].find((b) =>
		b.textContent?.endsWith(".confirm"),
	);
	if (!button) throw new Error(`Missing confirm: ${id}`);
	await act(async () => button.click());
}
async function open(section: "translate" | "layout") {
	await act(async () => openMobileProcessingSettings(section));
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.clearAllMocks();
	io.snapshot = structuredClone(DEFAULT_SETTINGS);
	io.snapshot.translate.provider = "agent";
	io.snapshot.translate.agentId = "local-agent";
	io.snapshot.layout.parserBackend = "agentero";
	io.save.mockImplementation(async (next: AppSettings) => {
		io.snapshot = next;
		return next;
	});
	io.probe.mockResolvedValue(true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			createElement(
				TooltipProvider,
				null,
				createElement(MobileProcessingSettings),
			),
		),
	);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("embedded mobile processing settings", () => {
	it("opens by event, excludes Agent/local effects and unsupported layout cards without mutating stored selections", async () => {
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await open("translate");
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(document.querySelector("#translate-cache-ir")).not.toBeNull();
		expect(document.querySelector("#translate-cache-final")).not.toBeNull();
		expect(io.agent).not.toHaveBeenCalled();
		expect(io.save).not.toHaveBeenCalled();
		await open("layout");
		expect(input("layout-provider-paddle-api-key")).not.toBeNull();
		expect(input("layout-provider-mineru-api-key")).not.toBeNull();
		expect(input("layout-provider-openaiCompatible-api-key")).toBeNull();
		expect(document.body.textContent).not.toContain(
			"layout.clearResults.clear",
		);
		expect(io.clear).not.toHaveBeenCalled();
		expect(io.agent).not.toHaveBeenCalled();
		expect(io.save).not.toHaveBeenCalled();
	});
	it("offers REST translation and only Paddle/MinerU layout choices", async () => {
		await open("translate");
		const trigger =
			document.querySelector<HTMLButtonElement>('[role="combobox"]');
		await act(async () =>
			trigger?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			),
		);
		const choices = [...document.querySelectorAll('[role="option"]')].map(
			(option) => option.textContent,
		);
		expect(choices.some((choice) => choice?.includes("openaiCompatible"))).toBe(
			true,
		);
		expect(choices.some((choice) => choice?.includes(".agent"))).toBe(false);
		await act(async () =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
		);
		await open("layout");
		await act(async () =>
			input("layout-backend").dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			),
		);
		expect(
			[...document.querySelectorAll('[role="option"]')].map(
				(option) => option.textContent,
			),
		).toEqual(["layout.backend.paddle", "layout.backend.mineru"]);
	});
	it("preserves saved cache choices and persists explicit IR/final toggles", async () => {
		if (!io.snapshot) throw new Error("missing settings");
		io.snapshot.translate.cacheReflowIr = false;
		io.snapshot.translate.cacheReflowFinal = false;
		await open("translate");
		expect(input("translate-cache-ir").getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(input("translate-cache-final").getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(io.save).not.toHaveBeenCalled();
		await act(async () => input("translate-cache-ir").click());
		expect(io.save.mock.calls.at(-1)?.[0].translate.cacheReflowIr).toBe(true);
		await act(async () => input("translate-cache-final").click());
		expect(io.save.mock.calls.at(-1)?.[0].translate.cacheReflowFinal).toBe(
			true,
		);
	});
	it("does not fall back to local when an API key is cleared", async () => {
		if (!io.snapshot) throw new Error("missing settings");
		io.snapshot.layout.backend = "mineru";
		io.snapshot.layout.parserBackend = "mineru";
		io.snapshot.layout.providerConfigs.mineru = {
			apiKey: "********",
			baseUrl: "https://old.example",
			model: "",
			prompt: "",
			language: "en",
			isOcr: false,
			selfHosted: false,
		};
		await open("layout");
		await change("layout-provider-mineru-api-key", "");
		expect(io.save.mock.calls[0][0].layout).toMatchObject({
			backend: "mineru",
			parserBackend: "mineru",
			providerConfigs: { mineru: { apiKey: "" } },
		});
	});
	it("persists translation key, endpoint and model through the existing Host save path", async () => {
		await open("translate");
		await change("translate-provider-openaiCompatible-api-key", "new-secret");
		await change(
			"translate-provider-openaiCompatible-base-url",
			"https://translate.example/v1",
		);
		await change("translate-provider-openaiCompatible-model", "test-model");
		await confirm("translate-provider-openaiCompatible-api-key");
		expect(
			io.save.mock.calls[0][0].translate.providerConfigs.openaiCompatible,
		).toMatchObject({
			apiKey: "new-secret",
			baseUrl: "https://translate.example/v1",
			model: "test-model",
		});
		expect(input("translate-provider-openaiCompatible-api-key").value).toBe(
			"**********",
		);
	});
	it("keeps masked layout keys on endpoint edits and reports failed saves without discarding drafts or probing", async () => {
		if (!io.snapshot) throw new Error("missing settings");
		io.snapshot.layout.backend = "mineru";
		io.snapshot.layout.providerConfigs.mineru = {
			apiKey: "********",
			baseUrl: "https://old.example",
			model: "",
			prompt: "",
			language: "en",
			isOcr: false,
			selfHosted: false,
		};
		await open("layout");
		await change("layout-provider-mineru-base-url", "https://new.example");
		await confirm("layout-provider-mineru-api-key");
		expect(
			io.save.mock.calls[0][0].layout.providerConfigs.mineru,
		).toMatchObject({ apiKey: "********", baseUrl: "https://new.example" });
		io.save.mockRejectedValueOnce(new Error("save denied"));
		io.probe.mockClear();
		await change("layout-provider-mineru-api-key", "retry-secret");
		await confirm("layout-provider-mineru-api-key");
		expect(io.error).toHaveBeenCalledWith("Error: save denied");
		expect(input("layout-provider-mineru-api-key").value).toBe("retry-secret");
		expect(io.probe).not.toHaveBeenCalled();
	});
	it("reports translation save errors and keeps the plaintext draft available for retry", async () => {
		await open("translate");
		await change("translate-provider-deepl-api-key", "retry-secret");
		io.save.mockRejectedValueOnce(new Error("save denied"));
		await confirm("translate-provider-deepl-api-key");
		expect(io.error).toHaveBeenCalledWith("Error: save denied");
		expect(input("translate-provider-deepl-api-key").value).toBe(
			"retry-secret",
		);
		expect(io.probe).not.toHaveBeenCalled();
	});
});
