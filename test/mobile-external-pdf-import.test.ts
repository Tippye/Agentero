// @vitest-environment happy-dom
import type { Event as TauriEvent } from "@tauri-apps/api/event";
import {
	act,
	createElement,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	tauri: true,
	visible: "visible",
	listen: vi.fn(),
	take: vi.fn(),
	error: vi.fn(),
	status: vi.fn(),
	refreshA: vi.fn(),
	refreshB: vi.fn(),
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => io.tauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: io.listen }));
vi.mock("@/lib/core/notify", () => ({ notifyError: io.error }));
vi.mock("@/lib/core/bindings", async (original) => {
	const actual = await original<typeof import("@/lib/core/bindings")>();
	return {
		...actual,
		commands: {
			...actual.commands,
			paperImportOpenedPdf: (...args: unknown[]) => io.take(...args),
		},
	};
});

import {
	type MobilePdfImportTarget,
	useMobileExternalPdfs,
} from "@/components/mobile/hooks/use-mobile-external-pdfs";
import { takeAndImportOpenedMobilePdf } from "@/lib/mobile/import-pdf";

type WakeHandler = (event: TauriEvent<null>) => void;
const listeners: { handler: WakeHandler; off: ReturnType<typeof vi.fn> }[] = [];
function subscription(handler: WakeHandler) {
	const entry = { handler, off: vi.fn() };
	listeners.push(entry);
	return entry;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function result(papers: unknown[] = [], errors: string[] = []) {
	return { status: "ok", data: { ok: true, data: { papers, errors } } };
}
const none = () => ({ status: "ok", data: { ok: true, data: null } });
let controls: {
	wake: () => void;
	releaseManual: () => void;
	admission: { current: boolean };
};
function Harness({
	vaultPath,
	refresh,
	manualBusy = false,
}: {
	vaultPath: string | null;
	refresh: () => Promise<void>;
	manualBusy?: boolean;
}) {
	const [importing, setImporting] = useState(false);
	const admission = useRef(manualBusy);
	const target = useRef<MobilePdfImportTarget>({
		mounted: false,
		vaultPath,
		epoch: 0,
		refresh,
	});
	useLayoutEffect(() => {
		target.current.mounted = true;
		target.current.vaultPath = vaultPath;
		target.current.epoch++;
		setImporting(false);
		return () => {
			target.current.mounted = false;
			target.current.epoch++;
		};
	}, [vaultPath]);
	useLayoutEffect(() => {
		target.current.refresh = refresh;
	}, [refresh]);
	const setBusy = useCallback((value: boolean) => {
		io.status(value);
		setImporting(value);
	}, []);
	const wake = useMobileExternalPdfs({
		vaultPath,
		admission,
		target,
		setImporting: setBusy,
	});
	controls = {
		wake,
		admission,
		releaseManual: () => {
			admission.current = false;
			setImporting(false);
			wake();
		},
	};
	return createElement("output", null, importing ? "busy" : "idle");
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let disposed = false;
async function render(
	vaultPath: string | null = "/private/Vault-A",
	refresh = io.refreshA,
	manualBusy = false,
) {
	await act(async () =>
		root.render(createElement(Harness, { vaultPath, refresh, manualBusy })),
	);
}
async function unmount() {
	await act(async () => root.unmount());
	disposed = true;
}
async function emit(index = listeners.length - 1) {
	await act(async () =>
		listeners[index].handler({
			event: "mobile:external-pdf-pending",
			id: 1,
			payload: null,
		}),
	);
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.resetAllMocks();
	io.tauri = true;
	io.visible = "visible";
	listeners.length = 0;
	disposed = false;
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
		io.visible === "visible" ? "visible" : "hidden",
	);
	io.listen.mockImplementation(
		async (_name: string, handler: WakeHandler) => subscription(handler).off,
	);
	io.take.mockResolvedValue(none());
	io.refreshA.mockResolvedValue(undefined);
	io.refreshB.mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	if (!disposed) await unmount();
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("system-opened PDF intake", () => {
	it("maps only the known native result and sends only the current vault", async () => {
		expect(await takeAndImportOpenedMobilePdf("/private/Vault-A")).toBeNull();
		io.take.mockResolvedValueOnce(result([{}, {}], ["one item failed"]));
		expect(await takeAndImportOpenedMobilePdf("/private/Vault-A")).toEqual({
			imported: 2,
			errors: ["one item failed"],
		});
		expect(io.take.mock.calls).toEqual([
			["/private/Vault-A"],
			["/private/Vault-A"],
		]);
	});
	it("never listens or consumes in a browser", async () => {
		io.tauri = false;
		await render();
		expect(io.listen).not.toHaveBeenCalled();
		expect(io.take).not.toHaveBeenCalled();
	});
	it.each([
		null,
		"",
		" ",
	])("does not consume before a local vault exists (%s)", async (vault) => {
		await render(vault);
		expect(io.listen).not.toHaveBeenCalled();
		expect(io.take).not.toHaveBeenCalled();
		await render();
		expect(io.listen).toHaveBeenCalledOnce();
		expect(io.take).toHaveBeenCalledExactlyOnceWith("/private/Vault-A");
	});
	it("subscribes before the initial consume and coalesces pre-registration wakes", async () => {
		const registration = deferred<() => void>();
		io.listen.mockImplementationOnce((_name: string, handler: WakeHandler) => {
			subscription(handler);
			return registration.promise;
		});
		await render();
		expect(io.listen).toHaveBeenCalledWith(
			"mobile:external-pdf-pending",
			expect.any(Function),
		);
		expect(io.take).not.toHaveBeenCalled();
		await emit();
		await emit();
		expect(io.take).not.toHaveBeenCalled();
		await act(async () => registration.resolve(listeners[0].off));
		expect(io.take).toHaveBeenCalledOnce();
		expect(io.refreshA).not.toHaveBeenCalled();
	});
	it("settles a null response without refresh, errors, rerender loops or an automatic second consume", async () => {
		await render();
		const wake = controls.wake;
		await render();
		await act(async () => {});
		expect(controls.wake).toBe(wake);
		expect(io.take).toHaveBeenCalledOnce();
		expect(io.refreshA).not.toHaveBeenCalled();
		expect(io.error).not.toHaveBeenCalled();
		expect(host.textContent).toBe("idle");
		expect(controls.admission.current).toBe(false);
	});
	it("queues one wake behind manual admission and drains when the manual finally releases it", async () => {
		await render("/private/Vault-A", io.refreshA, true);
		await emit();
		await emit();
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(io.take).not.toHaveBeenCalled();
		await act(async () => controls.releaseManual());
		expect(io.take).toHaveBeenCalledOnce();
		expect(io.refreshA).not.toHaveBeenCalled();
		expect(controls.admission.current).toBe(false);
	});
	it("keeps admission through refresh and drains only one coalesced wake after an external import", async () => {
		const command = deferred<ReturnType<typeof result>>();
		const refresh = deferred<void>();
		io.take.mockReturnValueOnce(command.promise);
		io.refreshA.mockReturnValueOnce(refresh.promise);
		await render();
		await emit();
		await emit();
		expect(io.take).toHaveBeenCalledOnce();
		expect(host.textContent).toBe("busy");
		await act(async () => command.resolve(result([{}])));
		expect(io.refreshA).toHaveBeenCalledOnce();
		expect(controls.admission.current).toBe(true);
		expect(io.take).toHaveBeenCalledOnce();
		await act(async () => refresh.resolve());
		expect(io.take).toHaveBeenCalledTimes(2);
		expect(io.refreshA).toHaveBeenCalledOnce();
		expect(host.textContent).toBe("idle");
		expect(controls.admission.current).toBe(false);
	});
	it("holds hidden wakes until the app becomes visible, then uses focus for a fresh drain", async () => {
		io.visible = "hidden";
		await render();
		await emit();
		await emit();
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(io.take).not.toHaveBeenCalled();
		io.visible = "visible";
		await act(async () =>
			document.dispatchEvent(new Event("visibilitychange")),
		);
		expect(io.take).toHaveBeenCalledOnce();
		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(io.take).toHaveBeenCalledTimes(2);
		expect(io.refreshA).not.toHaveBeenCalled();
	});
	it("cleans up a listener whose registration resolves after unmount and ignores its copied wake", async () => {
		const registration = deferred<() => void>();
		io.listen.mockImplementationOnce((_name: string, handler: WakeHandler) => {
			subscription(handler);
			return registration.promise;
		});
		await render();
		await unmount();
		await act(async () => registration.resolve(listeners[0].off));
		await emit(0);
		expect(listeners[0].off).toHaveBeenCalledOnce();
		expect(io.take).not.toHaveBeenCalled();
		expect(io.error).not.toHaveBeenCalled();
	});
	it("reports a current listener failure once and never consumes before subscription", async () => {
		io.listen.mockRejectedValueOnce(new Error("Subscribe failed"));
		await render();
		await act(async () => window.dispatchEvent(new Event("focus")));
		await render();
		expect(io.error).toHaveBeenCalledExactlyOnceWith("Subscribe failed");
		expect(io.take).not.toHaveBeenCalled();
		expect(io.listen).toHaveBeenCalledOnce();
	});
	it("lets an owned Rust import finish after unmount without late refresh, status or toast", async () => {
		const command = deferred<ReturnType<typeof result>>();
		io.take.mockReturnValueOnce(command.promise);
		await render();
		await unmount();
		const statuses = io.status.mock.calls.length;
		await act(async () => command.resolve(result([{}], ["old result"])));
		expect(io.refreshA).not.toHaveBeenCalled();
		expect(io.error).not.toHaveBeenCalled();
		expect(io.status).toHaveBeenCalledTimes(statuses);
		expect(controls.admission.current).toBe(false);
	});
	it("fences an old vault result and drains the new current vault only after old admission releases", async () => {
		const command = deferred<ReturnType<typeof result>>();
		io.take.mockReturnValueOnce(command.promise);
		await render();
		const stableWake = controls.wake;
		await render("/private/Vault-B", io.refreshB);
		expect(controls.wake).toBe(stableWake);
		expect(listeners[0].off).toHaveBeenCalledOnce();
		expect(io.take).toHaveBeenCalledOnce();
		await emit(0);
		await act(async () => command.resolve(result([{}], ["old vault error"])));
		expect(io.take.mock.calls).toEqual([
			["/private/Vault-A"],
			["/private/Vault-B"],
		]);
		expect(io.refreshA).not.toHaveBeenCalled();
		expect(io.refreshB).not.toHaveBeenCalled();
		expect(io.error).not.toHaveBeenCalled();
		expect(host.textContent).toBe("idle");
	});
	it("reports a response failure, observes the current catalog once and never replays the claim", async () => {
		io.take.mockRejectedValueOnce(new Error("Intake failed"));
		await render();
		await render();
		expect(io.error).toHaveBeenCalledExactlyOnceWith("Intake failed");
		expect(io.take).toHaveBeenCalledOnce();
		expect(io.refreshA).toHaveBeenCalledOnce();
		expect(host.textContent).toBe("idle");
	});
	it("refreshes a non-null partial result and reports errors once even if refresh also fails", async () => {
		io.take.mockResolvedValueOnce(result([], ["Provider failed"]));
		io.refreshA.mockRejectedValueOnce(new Error("Refresh failed"));
		await render();
		expect(io.refreshA).toHaveBeenCalledOnce();
		expect(io.error).toHaveBeenCalledExactlyOnceWith("Provider failed");
		expect(io.take).toHaveBeenCalledOnce();
		expect(host.textContent).toBe("idle");
	});
});
