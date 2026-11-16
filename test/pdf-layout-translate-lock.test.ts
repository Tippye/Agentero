// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

let visibility: DocumentVisibilityState = "visible";
let online = true;

function setVisibility(next: DocumentVisibilityState) {
	visibility = next;
	document.dispatchEvent(new Event("visibilitychange"));
}
function setOnline(next: boolean) {
	online = next;
	window.dispatchEvent(new Event("online"));
}

Object.defineProperty(document, "visibilityState", {
	configurable: true,
	get: () => visibility,
});
Object.defineProperty(navigator, "onLine", {
	configurable: true,
	get: () => online,
});

const runTranslate = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock("@/lib/translate", () => ({
	runTranslate: (...args: unknown[]) => runTranslate(...args),
}));
vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({
		translate: {
			provider: "tencenttransmart",
			targetLang: "zh-CN",
			sourceLang: "auto",
			providerConfigs: {},
			autoTranslateSelection: false,
			agentId: "",
			modelId: "",
		},
	}),
}));

import {
	appIsAvailable,
	holdBackgroundContinuation,
	waitForAppAvailability,
} from "@/lib/core/app-availability";
import { runLayoutRegionTranslate } from "@/lib/pdf/layout/layout-translate";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

describe("app availability gate", () => {
	beforeEach(() => {
		setVisibility("visible");
		setOnline(true);
	});

	it("treats a hidden page or a lost link as unavailable", () => {
		expect(appIsAvailable()).toBe(true);
		setVisibility("hidden");
		expect(appIsAvailable()).toBe(false);
		setVisibility("visible");
		setOnline(false);
		expect(appIsAvailable()).toBe(false);
		setOnline(true);
		expect(appIsAvailable()).toBe(true);
	});

	it("waits for the page to become visible again", async () => {
		setVisibility("hidden");
		let settled = false;
		const waiting = waitForAppAvailability().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		setVisibility("visible");
		await waiting;
		expect(settled).toBe(true);
	});

	it("keeps requesting while hidden under a Host transfer lease", () => {
		setVisibility("hidden");
		expect(appIsAvailable()).toBe(false);
		const release = holdBackgroundContinuation();
		expect(appIsAvailable()).toBe(true);
		release();
		release();
		expect(appIsAvailable()).toBe(false);
		// Losing the link still pauses even with the lease held.
		const held = holdBackgroundContinuation();
		setOnline(false);
		expect(appIsAvailable()).toBe(false);
		held();
		setOnline(true);
	});

	it("waits for the link to come back", async () => {
		setOnline(false);
		let settled = false;
		const waiting = waitForAppAvailability().then(() => {
			settled = true;
		});
		await Promise.resolve();
		setOnline(true);
		await waiting;
		expect(settled).toBe(true);
	});

	it("returns on abort so the caller observes cancellation", async () => {
		setVisibility("hidden");
		const controller = new AbortController();
		const waiting = waitForAppAvailability(controller.signal);
		controller.abort();
		await waiting;
		expect(controller.signal.aborted).toBe(true);
	});
});

describe("layout translation across a lock screen", () => {
	beforeEach(() => {
		setVisibility("visible");
		setOnline(true);
		runTranslate.mockReset();
	});

	it("retries a request interrupted by the lock instead of failing the block", async () => {
		runTranslate.mockImplementationOnce(async () => {
			// The device locks while the provider request is in flight; the
			// request fails because the webview can no longer reach the network.
			setVisibility("hidden");
			throw new Error(
				"error sending request for url (https://mt.example/api): client error (Connect): dns error",
			);
		});
		runTranslate.mockResolvedValueOnce("你好，世界。");

		const item: LayoutTranslateItem = {
			id: "block-1",
			pageIndex: 0,
			bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.1 },
			kind: "text",
			readingOrder: 0,
			source: "Hello world.",
			status: "pending",
		};
		const started = runLayoutRegionTranslate({
			items: [item],
			onUpdate: () => undefined,
		});
		await vi.waitFor(() => expect(runTranslate).toHaveBeenCalledTimes(1));
		// Let the runner observe the hidden page and park before unlocking.
		await Promise.resolve();
		setVisibility("visible");

		const items = await started;
		expect(items[0]?.status).toBe("done");
		expect(items[0]?.translated).toBe("你好，世界。");
		expect(runTranslate).toHaveBeenCalledTimes(2);
	});
});
