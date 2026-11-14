// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundState } from "@/lib/mobile/background";

const service = vi.hoisted(() => ({
	getState: vi.fn(),
	configure: vi.fn(),
	notifications: vi.fn(),
	settings: vi.fn(),
	changed: vi.fn(),
	error: vi.fn(),
	t: (key: string) => key,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: service.t }) }));
vi.mock("@/lib/core/notify", () => ({ notifyError: service.error }));
vi.mock("@/lib/mobile/background", () => ({
	getMobileBackgroundState: service.getState,
	configureMobileBackground: service.configure,
	requestMobileBackgroundNotifications: service.notifications,
	openMobileBackgroundSettings: service.settings,
}));

import { MobileBackgroundSettingsPanel } from "@/components/mobile/mobile-background-settings";

function nativeState(
	overrides: Partial<BackgroundState> = {},
): BackgroundState {
	return {
		platform: "android",
		persistentConnection: true,
		finiteTasks: false,
		backgroundTransfer: false,
		enabled: false,
		foreground: true,
		notificationPermission: "granted",
		notificationsEnabled: true,
		batteryOptimizationIgnored: false,
		agentActive: false,
		syncActive: false,
		finiteTaskActive: false,
		finiteTaskExpired: false,
		...overrides,
	};
}
function deferred<T>() {
	let finish: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		finish = resolve;
	});
	return { promise, resolve: (value: T) => finish(value) };
}
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let disposed = false;
async function render(active = true) {
	await act(async () =>
		root.render(
			createElement(MobileBackgroundSettingsPanel, {
				active,
				onStateChange: service.changed,
			}),
		),
	);
	await act(async () => {});
}
function panel(): HTMLElement {
	const element = container.firstElementChild;
	if (!(element instanceof HTMLElement))
		throw new Error("Missing background panel");
	return element;
}
function switchControl(): HTMLButtonElement {
	const control = panel().querySelector<HTMLButtonElement>('[role="switch"]');
	if (!control) throw new Error("Missing background switch");
	return control;
}
function button(label: string): HTMLButtonElement {
	const found = [...panel().querySelectorAll("button")].find(
		(item) =>
			item.getAttribute("aria-label") === label || item.textContent === label,
	);
	if (!found) throw new Error(`Missing button ${label}`);
	return found;
}
async function click(label: string) {
	await act(async () => button(label).click());
}
async function toggle() {
	await act(async () => switchControl().click());
}
function value(label: string) {
	const term = [...panel().querySelectorAll("dt")].find(
		(item) => item.textContent === label,
	);
	return term?.parentElement?.querySelector("dd")?.textContent;
}

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.clearAllMocks();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	service.getState.mockResolvedValue(nativeState());
	service.configure.mockImplementation(async (enabled: boolean) =>
		nativeState({ enabled }),
	);
	service.notifications.mockResolvedValue(nativeState());
	service.settings.mockResolvedValue(nativeState());
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	disposed = false;
});
afterEach(async () => {
	if (!disposed) await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

describe("Android background settings use observed native state", () => {
	it("reads only when active and never requests permission, enables or opens system settings on load", async () => {
		await render(false);
		expect(service.getState).not.toHaveBeenCalled();
		expect(service.changed).not.toHaveBeenCalled();
		expect(panel().textContent).toContain("background.title");
		expect(panel().querySelector('[role="switch"]')).toBeNull();
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(service.getState).not.toHaveBeenCalled();
		await render();
		expect(service.getState).toHaveBeenCalledOnce();
		expect(switchControl().getAttribute("aria-checked")).toBe("false");
		expect(service.notifications).not.toHaveBeenCalled();
		expect(service.configure).not.toHaveBeenCalled();
		expect(service.settings).not.toHaveBeenCalled();
	});
	it("renders inline panel chrome without a dialog or a close button", async () => {
		await render();
		expect(panel().querySelector("h2")?.textContent).toBe("background.title");
		expect(panel().textContent).toContain("background.description");
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(
			[...panel().querySelectorAll("button")].some(
				(item) => item.textContent === "background.close",
			),
		).toBe(false);
		const refreshButton = button("background.refresh");
		expect(refreshButton.disabled).toBe(false);
		expect(refreshButton.querySelector("svg")).not.toBeNull();
		service.getState.mockResolvedValueOnce(nativeState({ syncActive: true }));
		await click("background.refresh");
		expect(service.getState).toHaveBeenCalledTimes(2);
		expect(value("background.sync")).toBe("background.running");
	});
	it("requests notification permission only after explicit enable and waits for fresh granted/deliverable state", async () => {
		const prompt = nativeState({
			notificationPermission: "prompt",
			notificationsEnabled: false,
		});
		const granted = nativeState();
		const enabled = nativeState({ enabled: true });
		const permission = deferred<BackgroundState>();
		const configured = deferred<BackgroundState>();
		service.getState.mockResolvedValue(prompt);
		service.notifications.mockReturnValueOnce(permission.promise);
		service.configure.mockReturnValueOnce(configured.promise);
		await render();
		expect(service.notifications).not.toHaveBeenCalled();
		await toggle();
		expect(service.notifications).toHaveBeenCalledOnce();
		expect(service.configure).not.toHaveBeenCalled();
		expect(switchControl().disabled).toBe(true);
		expect(button("background.refresh").disabled).toBe(true);
		expect(switchControl().getAttribute("aria-checked")).toBe("false");
		service.getState.mockResolvedValue(granted);
		await act(async () => permission.resolve(granted));
		expect(service.getState).toHaveBeenCalledTimes(3);
		expect(service.configure).toHaveBeenCalledExactlyOnceWith(true);
		expect(switchControl().getAttribute("aria-checked")).toBe("false");
		await act(async () => configured.resolve(enabled));
		expect(switchControl().getAttribute("aria-checked")).toBe("true");
		expect(value("background.agent")).toBe("background.notRunning");
		expect(value("background.sync")).toBe("background.notRunning");
		expect(service.changed).toHaveBeenLastCalledWith(enabled);
	});
	it.each([
		[
			"denied",
			nativeState({
				notificationPermission: "denied",
				notificationsEnabled: false,
			}),
		],
		[
			"blocked delivery",
			nativeState({
				notificationPermission: "granted",
				notificationsEnabled: false,
			}),
		],
	])("never configures enabled when notifications are %s", async (_name, blocked) => {
		service.getState.mockResolvedValue(blocked);
		await render();
		await toggle();
		expect(service.configure).not.toHaveBeenCalled();
		expect(service.notifications).not.toHaveBeenCalled();
		expect(service.error).toHaveBeenCalledWith(
			"background.notificationsRequired",
		);
		expect(switchControl().getAttribute("aria-checked")).toBe("false");
		await click("background.notificationSettings");
		expect(service.settings).toHaveBeenCalledExactlyOnceWith("notifications");
	});
	it("shows denial after a permission prompt without enabling, and offers explicit notification settings", async () => {
		const prompt = nativeState({
			notificationPermission: "prompt",
			notificationsEnabled: false,
		});
		const denied = nativeState({
			notificationPermission: "denied",
			notificationsEnabled: false,
		});
		service.getState
			.mockResolvedValueOnce(prompt)
			.mockResolvedValueOnce(prompt)
			.mockResolvedValueOnce(denied);
		service.notifications.mockResolvedValueOnce(denied);
		await render();
		await toggle();
		expect(service.notifications).toHaveBeenCalledOnce();
		expect(service.configure).not.toHaveBeenCalled();
		expect(value("background.permission")).toBe(
			"background.permissions.denied",
		);
		expect(button("background.notificationSettings").disabled).toBe(false);
		expect(service.error).toHaveBeenCalledWith(
			"background.notificationsRequired",
		);
	});
	it("does not falsely check the switch or activity after configure failure and reports a toast", async () => {
		service.configure.mockRejectedValueOnce(
			new Error("Native refused the change"),
		);
		await render();
		await toggle();
		expect(switchControl().getAttribute("aria-checked")).toBe("false");
		expect(switchControl().disabled).toBe(false);
		expect(value("background.agent")).toBe("background.notRunning");
		expect(service.error).toHaveBeenCalledWith("background.failed", {
			description: "Native refused the change",
		});
		expect(
			service.changed.mock.calls.every(
				([state]: [BackgroundState]) => !state.enabled,
			),
		).toBe(true);
	});
	it("disables explicitly without requesting permissions even when already in the background", async () => {
		service.getState.mockResolvedValue(
			nativeState({
				enabled: true,
				foreground: false,
				notificationPermission: "denied",
				notificationsEnabled: false,
			}),
		);
		await render();
		expect(switchControl().disabled).toBe(false);
		await toggle();
		expect(service.configure).toHaveBeenCalledExactlyOnceWith(false);
		expect(service.notifications).not.toHaveBeenCalled();
		expect(service.getState).toHaveBeenCalledOnce();
		expect(switchControl().getAttribute("aria-checked")).toBe("false");
	});
	it("does not enable if a fresh observation shows the app left the foreground", async () => {
		service.getState
			.mockResolvedValueOnce(nativeState())
			.mockResolvedValueOnce(nativeState({ foreground: false }));
		await render();
		await toggle();
		expect(service.configure).not.toHaveBeenCalled();
		expect(service.notifications).not.toHaveBeenCalled();
		expect(service.error).toHaveBeenCalledWith("background.foregroundRequired");
		expect(switchControl().disabled).toBe(true);
	});
	it("prevents a slow earlier focus query from overwriting a newer configure acknowledgement", async () => {
		await render();
		const stale = deferred<BackgroundState>();
		service.getState.mockReturnValueOnce(stale.promise);
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(service.getState).toHaveBeenCalledTimes(2);
		const configured = nativeState({ enabled: true, agentActive: true });
		service.configure.mockResolvedValueOnce(configured);
		await toggle();
		expect(switchControl().getAttribute("aria-checked")).toBe("true");
		expect(value("background.agent")).toBe("background.running");
		const notifications = service.changed.mock.calls.length;
		await act(async () => stale.resolve(nativeState()));
		expect(service.changed).toHaveBeenCalledTimes(notifications);
		expect(service.changed).toHaveBeenLastCalledWith(configured);
		expect(switchControl().getAttribute("aria-checked")).toBe("true");
		expect(value("background.agent")).toBe("background.running");
	});
	it("updates active flags and OS state only from native refreshes, without turning preference into activity", async () => {
		service.getState.mockResolvedValue(nativeState({ enabled: true }));
		await render();
		expect(value("background.agent")).toBe("background.notRunning");
		expect(value("background.sync")).toBe("background.notRunning");
		const changed = nativeState({
			enabled: true,
			syncActive: true,
			batteryOptimizationIgnored: true,
			finiteTasks: true,
			finiteTaskActive: true,
			finiteTaskExpired: true,
		});
		service.getState.mockResolvedValueOnce(changed);
		await act(async () =>
			document.dispatchEvent(new Event("visibilitychange")),
		);
		expect(value("background.agent")).toBe("background.notRunning");
		expect(value("background.sync")).toBe("background.running");
		expect(value("background.battery")).toBe("background.unrestricted");
		expect(value("background.finiteTask")).toBe("background.running");
		expect(panel().textContent).toContain("background.finiteExpired");
		expect(service.configure).not.toHaveBeenCalled();
		expect(service.notifications).not.toHaveBeenCalled();
		expect(service.changed).toHaveBeenLastCalledWith(changed);
	});
	it("opens battery settings only from a click and refreshes status when the panel regains focus", async () => {
		await render();
		expect(service.settings).not.toHaveBeenCalled();
		await click("background.batterySettings");
		expect(service.settings).toHaveBeenCalledExactlyOnceWith("battery");
		service.getState.mockResolvedValueOnce(
			nativeState({ batteryOptimizationIgnored: true }),
		);
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(value("background.battery")).toBe("background.unrestricted");
		expect(service.configure).not.toHaveBeenCalled();
	});
	it("hides every persistent connection and permission control for iOS capabilities", async () => {
		const ios = nativeState({
			platform: "ios",
			persistentConnection: false,
			finiteTasks: true,
			finiteTaskActive: true,
			notificationPermission: "denied",
			notificationsEnabled: false,
			batteryOptimizationIgnored: null,
		});
		service.getState.mockResolvedValue(ios);
		await render();
		expect(panel().querySelector('[role="switch"]')).toBeNull();
		const content = panel().textContent ?? "";
		expect(content).not.toContain("background.enable");
		expect(content).not.toContain("background.notificationSettings");
		expect(content).not.toContain("background.batterySettings");
		expect(content).not.toMatch(/常驻|Token/);
		expect(content).toContain("background.systemManaged");
		expect(value("background.finiteTask")).toBe("background.running");
		expect(service.configure).not.toHaveBeenCalled();
		expect(service.notifications).not.toHaveBeenCalled();
		expect(service.settings).not.toHaveBeenCalled();
	});
	it("resets, clears published state and drops late callbacks when the panel becomes inactive", async () => {
		const configured = deferred<BackgroundState>();
		service.configure.mockReturnValueOnce(configured.promise);
		await render();
		await toggle();
		expect(service.configure).toHaveBeenCalledExactlyOnceWith(true);
		await render(false);
		expect(service.changed).toHaveBeenLastCalledWith(null);
		expect(
			service.changed.mock.calls.filter(([state]) => state === null),
		).toHaveLength(1);
		expect(panel().querySelector('[role="switch"]')).toBeNull();
		const callbacks = service.changed.mock.calls.length;
		await act(async () => configured.resolve(nativeState({ enabled: true })));
		expect(service.configure).toHaveBeenCalledOnce();
		expect(service.changed).toHaveBeenCalledTimes(callbacks);
		expect(service.error).not.toHaveBeenCalled();
	});
	it("drops all late native callbacks after unmount", async () => {
		const configured = deferred<BackgroundState>();
		service.configure.mockReturnValueOnce(configured.promise);
		await render();
		await toggle();
		const callbacks = service.changed.mock.calls.length;
		await act(async () => root.unmount());
		disposed = true;
		await act(async () =>
			configured.resolve(nativeState({ enabled: true, agentActive: true })),
		);
		expect(service.changed).toHaveBeenCalledTimes(callbacks);
		expect(service.error).not.toHaveBeenCalled();
	});
	it("blocks double clicks while native work is pending", async () => {
		await render();
		const fresh = deferred<BackgroundState>();
		service.getState.mockReturnValueOnce(fresh.promise);
		await toggle();
		expect(switchControl().disabled).toBe(true);
		await toggle();
		expect(service.getState).toHaveBeenCalledTimes(2);
		expect(service.configure).not.toHaveBeenCalled();
		await act(async () => fresh.resolve(nativeState()));
		expect(service.configure).toHaveBeenCalledExactlyOnceWith(true);
		expect(service.notifications).not.toHaveBeenCalled();
	});
});
