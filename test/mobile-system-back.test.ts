// @vitest-environment happy-dom
import type { onBackButtonPress } from "@tauri-apps/api/app";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundState } from "@/lib/mobile/background";

const native = vi.hoisted(() => ({
	tauri: vi.fn(),
	platform: vi.fn(),
	register: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: native.tauri }));
vi.mock("@/lib/mobile/background", () => ({
	getMobileBackgroundState: native.platform,
}));
vi.mock("@tauri-apps/api/app", () => ({ onBackButtonPress: native.register }));
vi.mock("@/lib/core/notify", () => ({ notifyError: native.error }));

import {
	type UseMobileSystemBackOptions,
	useMobileSystemBack,
} from "@/components/mobile/hooks/use-mobile-system-back";

type BackHandler = Parameters<typeof onBackButtonPress>[0];
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const background: BackgroundState = {
	platform: "android",
	persistentConnection: true,
	finiteTasks: true,
	backgroundTransfer: true,
	enabled: true,
	foreground: true,
	notificationPermission: "granted",
	notificationsEnabled: true,
	batteryOptimizationIgnored: false,
	agentActive: false,
	syncActive: false,
	finiteTaskActive: false,
	finiteTaskExpired: false,
};
const records: ReturnType<typeof record>[] = [];
const active = new Set<number>();
let peak = 0;
function record(handler: BackHandler) {
	const id = records.length + 1;
	const listener = {
		plugin: "app",
		event: "back-button",
		channelId: id,
		unregister: vi.fn(async () => {
			active.delete(id);
		}),
	};
	const entry = { handler, listener };
	records.push(entry);
	active.add(id);
	peak = Math.max(peak, active.size);
	return entry;
}
function Harness(props: UseMobileSystemBackOptions) {
	return createElement("output", null, String(useMobileSystemBack(props)));
}
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let disposed = false;
const back = vi.fn();
async function render(
	enabled = true,
	callback: () => void = back,
	strict = false,
) {
	const element = createElement(Harness, { enabled, onBack: callback });
	await act(async () =>
		root.render(strict ? createElement(StrictMode, null, element) : element),
	);
}
async function unmount() {
	await act(async () => root.unmount());
	disposed = true;
}
async function press(index = records.length - 1) {
	await act(async () => records[index].handler({ canGoBack: false }));
}
function android() {
	return container.querySelector("output")?.textContent === "true";
}

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.resetAllMocks();
	records.length = 0;
	active.clear();
	peak = 0;
	disposed = false;
	native.tauri.mockReturnValue(true);
	native.platform.mockResolvedValue(background);
	native.register.mockImplementation(
		async (handler: BackHandler) => record(handler).listener,
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	if (!disposed) await unmount();
	container.remove();
	vi.restoreAllMocks();
});

describe("Android system back lifecycle", () => {
	it("never probes or registers in a browser even when enabled", async () => {
		native.tauri.mockReturnValue(false);
		await render();
		await render(false);
		await render();
		expect(android()).toBe(false);
		expect(native.tauri).toHaveBeenCalledOnce();
		expect(native.platform).not.toHaveBeenCalled();
		expect(native.register).not.toHaveBeenCalled();
	});
	it.each([
		"desktop",
		"ios",
	] as const)("never registers on native %s", async (platform) => {
		native.platform.mockResolvedValue({ ...background, platform });
		await render();
		await render(false);
		await render();
		expect(android()).toBe(false);
		expect(native.platform).toHaveBeenCalledOnce();
		expect(native.register).not.toHaveBeenCalled();
	});
	it("returns actual Android while a clean root has no listener", async () => {
		await render(false);
		expect(android()).toBe(true);
		expect(native.platform).toHaveBeenCalledOnce();
		expect(native.register).not.toHaveBeenCalled();
		await render(true);
		expect(native.platform).toHaveBeenCalledOnce();
		expect(native.register).toHaveBeenCalledOnce();
	});
	it("uses the latest committed callback without re-registering", async () => {
		const next = vi.fn();
		await render();
		await press();
		expect(back).toHaveBeenCalledOnce();
		await render(true, next);
		await press();
		expect(back).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledOnce();
		expect(native.register).toHaveBeenCalledOnce();
	});
	it("removes its individual channel on disable and ignores copied stale events", async () => {
		await render();
		const first = records[0];
		await render(false);
		expect(active.size).toBe(0);
		expect(first.listener.unregister).toHaveBeenCalledOnce();
		await press(0);
		expect(back).not.toHaveBeenCalled();
		await render();
		expect(records).toHaveLength(2);
		await press(0);
		expect(back).not.toHaveBeenCalled();
		await press(1);
		expect(back).toHaveBeenCalledOnce();
		await unmount();
		expect(records[1].listener.unregister).toHaveBeenCalledOnce();
		expect(active.size).toBe(0);
		expect(peak).toBe(1);
		await press(1);
		expect(back).toHaveBeenCalledOnce();
	});
	it("keeps one platform probe and one live channel through StrictMode effects", async () => {
		await render(true, back, true);
		expect(android()).toBe(true);
		expect(native.platform).toHaveBeenCalledOnce();
		expect(native.register).toHaveBeenCalledOnce();
		expect(active.size).toBe(1);
		await unmount();
		expect(active.size).toBe(0);
		expect(records[0].listener.unregister).toHaveBeenCalledOnce();
		expect(peak).toBe(1);
	});
	it("serializes deferred registration and removal before a rapid replacement", async () => {
		const registration =
			deferred<Awaited<ReturnType<typeof onBackButtonPress>>>();
		const removal = deferred<void>();
		native.register.mockImplementationOnce((handler: BackHandler) => {
			const entry = record(handler);
			entry.listener.unregister.mockImplementationOnce(async () => {
				await removal.promise;
				active.delete(entry.listener.channelId);
			});
			return registration.promise;
		});
		await render();
		expect(records).toHaveLength(1);
		await render(false);
		await render();
		await press(0);
		expect(back).not.toHaveBeenCalled();
		expect(native.register).toHaveBeenCalledOnce();
		await act(async () => registration.resolve(records[0].listener));
		expect(records[0].listener.unregister).toHaveBeenCalledOnce();
		expect(native.register).toHaveBeenCalledOnce();
		await act(async () => removal.resolve());
		expect(native.register).toHaveBeenCalledTimes(2);
		expect(active.size).toBe(1);
		expect(peak).toBe(1);
		await press(0);
		expect(back).not.toHaveBeenCalled();
		await press(1);
		expect(back).toHaveBeenCalledOnce();
		await unmount();
		expect(active.size).toBe(0);
	});
	it("unregisters a late registration result after unmount", async () => {
		const registration =
			deferred<Awaited<ReturnType<typeof onBackButtonPress>>>();
		native.register.mockImplementationOnce((handler: BackHandler) => {
			record(handler);
			return registration.promise;
		});
		await render();
		await unmount();
		await press(0);
		expect(back).not.toHaveBeenCalled();
		await act(async () => registration.resolve(records[0].listener));
		expect(records[0].listener.unregister).toHaveBeenCalledOnce();
		expect(active.size).toBe(0);
	});
	it("does not register if disabled while the one platform probe is pending", async () => {
		const probe = deferred<BackgroundState>();
		native.platform.mockReturnValueOnce(probe.promise);
		await render();
		await render(false);
		await act(async () => probe.resolve(background));
		expect(android()).toBe(true);
		expect(native.register).not.toHaveBeenCalled();
		await render();
		expect(native.platform).toHaveBeenCalledOnce();
		expect(native.register).toHaveBeenCalledOnce();
	});
	it("does not register when the platform probe resolves after unmount", async () => {
		const probe = deferred<BackgroundState>();
		native.platform.mockReturnValueOnce(probe.promise);
		await render();
		await unmount();
		await act(async () => probe.resolve(background));
		expect(native.register).not.toHaveBeenCalled();
		expect(native.error).not.toHaveBeenCalled();
	});
	it("reports a failed platform probe once under StrictMode without pretending Android", async () => {
		native.platform.mockRejectedValueOnce(new Error("Platform failed"));
		await render(true, back, true);
		expect(android()).toBe(false);
		expect(native.error).toHaveBeenCalledExactlyOnceWith("Platform failed");
		expect(native.platform).toHaveBeenCalledOnce();
		expect(native.register).not.toHaveBeenCalled();
	});
	it("observes registration rejection and retries only after an explicit lifecycle transition", async () => {
		native.register.mockRejectedValueOnce(new Error("Registration failed"));
		await render();
		expect(android()).toBe(true);
		expect(native.error).toHaveBeenCalledExactlyOnceWith("Registration failed");
		await render();
		expect(native.register).toHaveBeenCalledOnce();
		await render(false);
		await render();
		expect(native.register).toHaveBeenCalledTimes(2);
		expect(active.size).toBe(1);
	});
	it("observes late removal rejection and fences replacement while native ownership is unknown", async () => {
		const removal = deferred<void>();
		await render();
		records[0].listener.unregister.mockReturnValueOnce(removal.promise);
		await render(false);
		await render();
		expect(native.register).toHaveBeenCalledOnce();
		await act(async () => removal.reject(new Error("Removal failed")));
		expect(native.error).toHaveBeenCalledExactlyOnceWith("Removal failed");
		expect(native.register).toHaveBeenCalledOnce();
		await press(0);
		expect(back).not.toHaveBeenCalled();
		await render(false);
		await render();
		expect(native.register).toHaveBeenCalledOnce();
		expect(records[0].listener.unregister).toHaveBeenCalledOnce();
	});
	it("observes callback exceptions without throwing back through the native channel", async () => {
		const fails = vi.fn(() => {
			throw new Error("Back guard failed");
		});
		await render(true, fails);
		await press();
		expect(native.error).toHaveBeenCalledExactlyOnceWith("Back guard failed");
		await render(true, () => Promise.reject(new Error("Async guard failed")));
		await press();
		expect(native.error).toHaveBeenLastCalledWith("Async guard failed");
		expect(native.register).toHaveBeenCalledOnce();
	});
});
