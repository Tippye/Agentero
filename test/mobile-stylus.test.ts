import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	enabled: true,
	handlers: new Map<string, (event: { payload: unknown }) => void>(),
	stop: vi.fn(),
	read: vi.fn(),
	target: vi.fn(),
	listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => native.enabled }));
vi.mock("@/lib/core/ipc", () => ({
	callApiResult: (call: () => unknown) => call(),
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		mobileStylusGetState: native.read,
		mobileStylusSetTarget: native.target,
	},
}));
const empty = { adapters: [], presence: [] };
const action = (targetToken: string) => ({
	targetToken,
	action: "toggleEraser",
	source: "nativePencilInteraction",
	adapterId: "apple-pencil-interaction",
});

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	native.enabled = true;
	native.handlers.clear();
	native.read.mockResolvedValue(empty);
	native.target.mockResolvedValue(empty);
	native.listen.mockImplementation(async (name, listener) => {
		native.handlers.set(name, listener);
		return () => {
			native.handlers.delete(name);
			native.stop(name);
		};
	});
});

describe("scoped native stylus facade", () => {
	it("filters actions and presence by the current PDF token and disposes listeners", async () => {
		const api = await import("@/lib/mobile/stylus");
		const receive = vi.fn(),
			presence = vi.fn();
		const stopActions = api.subscribeStylusActions(receive),
			stopPresence = api.subscribeStylusPresence(presence);
		const close = api.activateStylusTarget("paper/one");
		await vi.waitFor(() => expect(native.target).toHaveBeenCalledTimes(1));
		const token = native.target.mock.calls[0][0];
		native.handlers.get("mobile:stylus-action")?.({
			payload: action("stale-document"),
		});
		native.handlers.get("mobile:stylus-action")?.({ payload: action(token) });
		expect(receive).toHaveBeenCalledTimes(1);
		const observed = {
			available: true,
			proximity: null,
			source: "nativeInputDevice",
			adapterId: "android-input-device",
		};
		native.handlers.get("mobile:stylus-presence")?.({
			payload: { targetToken: "stale-document", presence: observed },
		});
		native.handlers.get("mobile:stylus-presence")?.({
			payload: { targetToken: token, presence: observed },
		});
		expect(presence).toHaveBeenCalledExactlyOnceWith(observed);
		close();
		stopActions();
		stopPresence();
		native.handlers.get("mobile:stylus-action")?.({ payload: action(token) });
		expect(receive).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(native.stop).toHaveBeenCalledTimes(2));
	});

	it("keeps a new document target when a previous cleanup arrives late", async () => {
		const api = await import("@/lib/mobile/stylus");
		const receive = vi.fn(),
			stop = api.subscribeStylusActions(receive);
		const closeOld = api.activateStylusTarget("old");
		await vi.waitFor(() => expect(native.target).toHaveBeenCalledTimes(1));
		const oldToken = native.target.mock.calls[0][0];
		const closeNew = api.activateStylusTarget("new");
		expect(api.isStylusTarget("old")).toBe(false);
		expect(api.isStylusTarget("new")).toBe(true);
		closeOld();
		expect(api.isStylusTarget("new")).toBe(true);
		await vi.waitFor(() => expect(native.target).toHaveBeenCalledTimes(3));
		const newToken = native.target.mock.calls[1][0];
		expect(native.target.mock.calls[2]).toEqual([oldToken, false]);
		native.handlers.get("mobile:stylus-action")?.({
			payload: action(oldToken),
		});
		native.handlers.get("mobile:stylus-action")?.({
			payload: action(newToken),
		});
		expect(receive).toHaveBeenCalledExactlyOnceWith(action(newToken));
		closeNew();
		stop();
		await vi.waitFor(() => expect(native.stop).toHaveBeenCalledTimes(2));
	});

	it("cancels activation before listener registration completes without leaking subscriptions", async () => {
		let release: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		native.listen.mockImplementation(async (name, listener) => {
			await barrier;
			native.handlers.set(name, listener);
			return () => {
				native.handlers.delete(name);
				native.stop(name);
			};
		});
		const api = await import("@/lib/mobile/stylus");
		const stop = api.subscribeStylusActions(vi.fn());
		const close = api.activateStylusTarget("cancelled");
		stop();
		close();
		release?.();
		await vi.waitFor(() => expect(native.stop).toHaveBeenCalledTimes(2));
		expect(
			native.target.mock.calls.filter((call) => call[1] === true),
		).toHaveLength(0);
	});

	it("reports observed pointer provenance only during an active visible target", async () => {
		native.enabled = false;
		const api = await import("@/lib/mobile/stylus");
		const receive = vi.fn(),
			stop = api.subscribeStylusPresence(receive);
		api.observeStylusPointerPresence(true);
		expect(receive).not.toHaveBeenCalled();
		const close = api.activateStylusTarget("observed");
		api.observeStylusPointerPresence(true);
		expect(receive).toHaveBeenCalledExactlyOnceWith({
			available: true,
			proximity: true,
			source: "pointer",
			adapterId: "web-pointer",
		});
		close();
		api.observeStylusPointerPresence(false);
		stop();
		expect(receive).toHaveBeenCalledTimes(1);
		expect(native.target).not.toHaveBeenCalled();
		expect(await api.getMobileStylusState()).toEqual(empty);
	});

	it("does not deliver native actions while the document is hidden", async () => {
		const api = await import("@/lib/mobile/stylus");
		const receive = vi.fn(),
			stop = api.subscribeStylusActions(receive);
		const close = api.activateStylusTarget("active");
		await vi.waitFor(() => expect(native.target).toHaveBeenCalledTimes(1));
		const token = native.target.mock.calls[0][0];
		vi.stubGlobal("document", { visibilityState: "hidden" });
		try {
			native.handlers.get("mobile:stylus-action")?.({ payload: action(token) });
			expect(receive).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
			close();
			stop();
		}
		await vi.waitFor(() => expect(native.stop).toHaveBeenCalledTimes(2));
	});
});
