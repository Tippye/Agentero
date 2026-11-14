import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/translate/api", () => ({
	invokeTranslateText: state.invoke,
}));

import { probeCommercialMtProvider } from "@/lib/translate/probe";

const config = {
	apiKey: "sk-test",
	baseUrl: "https://api.example.test/v1",
	region: "",
	model: "test-model",
	extraRequestBody: "",
};

describe("commercial translation probe error detail", () => {
	it("reports the Host rejection so settings can show the cause", async () => {
		const error = new Error("request timed out");
		state.invoke.mockRejectedValueOnce(error);
		const onError = vi.fn();
		await expect(
			probeCommercialMtProvider("openaiCompatible", { config, onError }),
		).resolves.toBe(false);
		expect(onError).toHaveBeenCalledExactlyOnceWith("openaiCompatible", error);
	});

	it("stays quiet on success", async () => {
		state.invoke.mockResolvedValueOnce("你好");
		const onError = vi.fn();
		await expect(
			probeCommercialMtProvider("openaiCompatible", { config, onError }),
		).resolves.toBe(true);
		expect(onError).not.toHaveBeenCalled();
	});

	it("does not call the Host or report an error when the config is incomplete", async () => {
		state.invoke.mockClear();
		const onError = vi.fn();
		await expect(
			probeCommercialMtProvider("openaiCompatible", {
				config: { ...config, apiKey: "", model: "" },
				onError,
			}),
		).resolves.toBe(false);
		expect(state.invoke).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});
});
