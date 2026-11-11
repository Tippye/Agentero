// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClientStatus } from "@/lib/bridge/client";

const host = vi.hoisted(() => ({
	resume: vi.fn(),
	status: vi.fn(),
	disconnect: vi.fn(),
	reset: vi.fn(),
	notify: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		bridgeClientResume: host.resume,
		bridgeClientStatus: host.status,
		bridgeClientDisconnect: host.disconnect,
		bridgeClientResetIdentity: host.reset,
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (
		event: string,
		callback: (event: { payload: unknown }) => void,
	) => {
		host.listeners.set(event, callback);
		return () => {
			host.listeners.delete(event);
		};
	},
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: host.notify }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { useBridgeStatus } from "@/components/mobile/hooks/use-bridge-status";
import { MobileBridgeReset } from "@/components/mobile/mobile-bridge-reset";
import { bridgeResume } from "@/lib/bridge/client";

const saved: BridgeClientStatus = {
	connected: false,
	paired: true,
	hostName: "Saved desktop",
};
const ok = (data: unknown) => ({ ok: true, data, error: null });
const success = (data: unknown) => ({ status: "ok", data: ok(data) });
const failure = (code: string) => ({
	status: "ok",
	data: {
		ok: false,
		data: null,
		error: { code, message: "fixed native failure" },
	},
});
let root: Root;
let container: HTMLDivElement;
let observed: ReturnType<typeof useBridgeStatus>;
function Probe({ enabled }: { enabled: boolean }) {
	observed = useBridgeStatus(enabled);
	return null;
}
async function render(enabled: boolean) {
	await act(async () => {
		root.render(createElement(Probe, { enabled }));
	});
}
async function visible() {
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	vi.clearAllMocks();
	host.listeners.clear();
	host.status.mockResolvedValue(ok(saved));
	host.resume.mockResolvedValue(success(saved));
	host.disconnect.mockResolvedValue(ok(null));
	host.reset.mockResolvedValue(success({ connected: false, paired: false }));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("Bridge native recovery", () => {
	it("reads public pairing metadata without opening Bridge while DSH is selected", async () => {
		await render(false);
		expect(observed.status).toEqual(saved);
		expect(host.resume).not.toHaveBeenCalled();
		await visible();
		expect(host.resume).not.toHaveBeenCalled();
	});
	it("keeps typed system-store failures and the saved pairing instead of showing unpaired", async () => {
		host.resume.mockResolvedValue(failure("bridge_identity_locked"));
		await expect(bridgeResume()).rejects.toMatchObject({
			code: "bridge_identity_locked",
		});
		await render(true);
		expect(observed.status).toEqual(saved);
		expect(observed.resetAvailable).toBe(false);
		expect(host.notify).toHaveBeenCalledWith("errors.bridgeIdentityLocked");
		await visible();
		expect(host.notify).toHaveBeenCalledTimes(1);
	});
	it("manual disconnect keeps pairing and rejects an older in-flight resume result", async () => {
		let finish!: (value: unknown) => void;
		host.resume.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await render(true);
		await act(async () => {
			await observed.disconnect();
		});
		await act(async () => {
			finish(success({ ...saved, connected: true }));
		});
		expect(observed.status).toEqual(saved);
		await visible();
		expect(host.resume).toHaveBeenCalledTimes(1);
	});
	it("an older resume response cannot overwrite a newer native status event", async () => {
		let finish!: (value: unknown) => void;
		host.resume.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await render(true);
		await act(async () => {
			host.listeners.get("bridge:status")?.({
				payload: { ...saved, connected: true },
			});
			finish(success(saved));
		});
		expect(observed.status.connected).toBe(true);
	});
	it("only offers destructive recovery for invalid/missing/partial-cleanup identities", async () => {
		host.resume.mockResolvedValue(failure("bridge_identity_invalid"));
		await render(true);
		expect(observed.resetAvailable).toBe(true);
		expect(host.reset).not.toHaveBeenCalled();
	});
	it("requires explicit confirmation, retains failed cleanup and adopts status only after success", async () => {
		const adopt = vi.fn();
		host.reset.mockResolvedValueOnce(
			failure("bridge_identity_cleanup_pending"),
		);
		await act(async () => {
			root.render(createElement(MobileBridgeReset, { onStatus: adopt }));
		});
		await act(async () => {
			container.querySelector<HTMLButtonElement>("button")?.click();
		});
		expect(host.reset).not.toHaveBeenCalled();
		const confirm = () =>
			[
				...document.querySelectorAll<HTMLButtonElement>(
					'[role="alertdialog"] button',
				),
			].find((button) => button.textContent === "connect.resetIdentity");
		await act(async () => {
			confirm()?.click();
		});
		expect(host.reset).toHaveBeenCalledTimes(1);
		expect(adopt).not.toHaveBeenCalled();
		expect(host.notify).toHaveBeenCalledWith("errors.bridgeIdentityCleanup");
		await act(async () => {
			confirm()?.click();
		});
		expect(adopt).toHaveBeenCalledWith({ connected: false, paired: false });
	});
});
