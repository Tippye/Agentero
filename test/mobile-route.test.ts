// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	MobileRouteSnapshot,
	MobileWindowRoute,
} from "@/lib/mobile/route";

const service = vi.hoisted(() => ({
	read: vi.fn(),
	save: vi.fn(),
	restore: vi.fn(),
	error: vi.fn(),
	t: (key: string) => key,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: service.t }) }));
vi.mock("@/lib/core/notify", () => ({ notifyError: service.error }));
vi.mock("@/lib/mobile/route", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/mobile/route")>()),
	readMobileRoute: service.read,
	saveMobileRoute: service.save,
}));

import { useMobileRoute } from "@/components/mobile/hooks/use-mobile-route";

const defaults: MobileWindowRoute = {
	paperId: null,
	tab: "library",
	readerMode: "pdf",
	preset: "read",
	pdf: null,
};
const paperA: MobileWindowRoute = {
	paperId: "paper-a",
	tab: "library",
	readerMode: "notes",
	preset: "compare",
	pdf: { page: 12, zoom: 1.4 },
};
const paperB: MobileWindowRoute = {
	paperId: "paper-b",
	tab: "agent",
	readerMode: "pdf",
	preset: "discuss",
	pdf: { page: 3, zoom: 0.8 },
};
function deferred<T>() {
	let finish: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		finish = resolve;
	});
	return { promise, resolve: (value: T) => finish(value) };
}
let actions: {
	mark: () => void;
	navigate: (route: MobileWindowRoute) => void;
} | null = null;
function Harness({
	vaultPath,
	loading,
	papers,
}: {
	vaultPath: string | null;
	loading: boolean;
	papers: string[];
}) {
	const [route, setRoute] = useState(defaults);
	const { markInteraction } = useMobileRoute({
		vaultPath,
		loading,
		route,
		onRestore: (restored) => {
			service.restore(restored);
			setRoute(
				restored.paperId && !papers.includes(restored.paperId)
					? { ...restored, paperId: null, pdf: null }
					: restored,
			);
		},
	});
	actions = {
		mark: markInteraction,
		navigate: (next) => {
			markInteraction();
			setRoute(next);
		},
	};
	return createElement("output", null, JSON.stringify(route));
}
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let disposed = false;
async function render({
	vaultPath = "/private/Vault",
	loading = false,
	papers = ["paper-a", "paper-b"],
}: {
	vaultPath?: string | null;
	loading?: boolean;
	papers?: string[];
} = {}) {
	await act(async () =>
		root.render(createElement(Harness, { vaultPath, loading, papers })),
	);
	await act(async () => {});
}
async function navigate(route: MobileWindowRoute) {
	await act(async () => {
		if (!actions) throw new Error("Hook not mounted");
		actions.navigate(route);
	});
}
async function advance(ms = 400) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
function visibleRoute() {
	return JSON.parse(container.querySelector("output")?.textContent ?? "null");
}

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		configurable: true,
		value: {},
	});
	vi.useFakeTimers();
	vi.clearAllMocks();
	actions = null;
	disposed = false;
	service.read.mockResolvedValue({ revision: "0", route: defaults });
	service.save.mockImplementation(
		async (
			_vault: string,
			revision: string,
			route: MobileWindowRoute,
		): Promise<MobileRouteSnapshot> => ({
			revision: String(BigInt(revision) + 1n),
			route,
		}),
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	if (!disposed) await act(async () => root.unmount());
	container.remove();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("durable mobile reading route hook", () => {
	it("uses the real native-only gate and has no plain-browser fallback", async () => {
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		await render();
		await navigate(paperA);
		await advance(1000);
		expect(service.read).not.toHaveBeenCalled();
		expect(service.save).not.toHaveBeenCalled();
		expect(service.restore).not.toHaveBeenCalled();
	});
	it("waits for the catalog and restores in a batch without ever saving initial defaults", async () => {
		service.read.mockResolvedValueOnce({ revision: "7", route: paperA });
		await render({ loading: true, papers: [] });
		await advance(1000);
		expect(service.read).toHaveBeenCalledExactlyOnceWith("/private/Vault");
		expect(service.restore).not.toHaveBeenCalled();
		expect(service.save).not.toHaveBeenCalled();
		await render({ loading: false, papers: ["paper-a"] });
		expect(service.restore).toHaveBeenCalledExactlyOnceWith(paperA);
		expect(visibleRoute()).toEqual(paperA);
		await advance(1000);
		expect(service.save).not.toHaveBeenCalled();
	});
	it("preserves interaction before vault availability rather than restoring over current intent", async () => {
		service.read.mockResolvedValueOnce({ revision: "7", route: paperA });
		await render({ vaultPath: null, loading: true });
		await navigate(paperB);
		await render({ loading: false });
		await advance();
		expect(service.restore).not.toHaveBeenCalled();
		expect(visibleRoute()).toEqual(paperB);
		expect(service.save).toHaveBeenCalledExactlyOnceWith(
			"/private/Vault",
			"7",
			paperB,
		);
	});
	it("keeps user navigation during a slow read and uses the returned revision for that intent", async () => {
		const read = deferred<MobileRouteSnapshot>();
		service.read.mockReturnValueOnce(read.promise);
		await render({ loading: true, papers: [] });
		await navigate(paperB);
		await act(async () =>
			read.resolve({ revision: "9007199254740993", route: paperA }),
		);
		await render({ loading: false, papers: ["paper-a", "paper-b"] });
		await advance();
		expect(service.restore).not.toHaveBeenCalled();
		expect(visibleRoute()).toEqual(paperB);
		expect(service.save).toHaveBeenCalledExactlyOnceWith(
			"/private/Vault",
			"9007199254740993",
			paperB,
		);
	});
	it("lets the parent resolve a missing paper only after the loaded catalog is available", async () => {
		service.read.mockResolvedValueOnce({ revision: "3", route: paperA });
		await render({ loading: true, papers: [] });
		expect(service.restore).not.toHaveBeenCalled();
		await render({ papers: ["paper-b"] });
		await advance();
		const resolved = { ...paperA, paperId: null, pdf: null };
		expect(visibleRoute()).toEqual(resolved);
		expect(service.save).toHaveBeenCalledExactlyOnceWith(
			"/private/Vault",
			"3",
			resolved,
		);
	});
	it("serializes writes and coalesces all changes during an inflight save to the latest route", async () => {
		await render();
		const first = deferred<MobileRouteSnapshot>();
		service.save.mockReturnValueOnce(first.promise);
		await navigate(paperA);
		await advance();
		expect(service.save).toHaveBeenCalledOnce();
		await navigate({ ...paperB, pdf: { page: 4, zoom: 1 } });
		await advance();
		await navigate(paperB);
		await advance();
		expect(service.save).toHaveBeenCalledOnce();
		await act(async () => first.resolve({ revision: "1", route: paperA }));
		expect(service.save).toHaveBeenCalledTimes(2);
		expect(service.save.mock.calls[1]).toEqual(["/private/Vault", "1", paperB]);
	});
	it("does not lose a return to the previously persisted paper while another paper is saving", async () => {
		service.read.mockResolvedValueOnce({ revision: "4", route: paperA });
		await render();
		const first = deferred<MobileRouteSnapshot>();
		service.save.mockReturnValueOnce(first.promise);
		await navigate(paperB);
		await advance();
		await navigate(paperA);
		await advance();
		expect(service.save).toHaveBeenCalledOnce();
		await act(async () => first.resolve({ revision: "5", route: paperB }));
		expect(service.save.mock.calls[1]).toEqual(["/private/Vault", "5", paperA]);
	});
	it("waits for an old-vault RPC and never applies its snapshot to the next vault", async () => {
		const old = deferred<MobileRouteSnapshot>();
		service.read
			.mockReturnValueOnce(old.promise)
			.mockResolvedValueOnce({ revision: "9", route: paperB });
		await render();
		await render({ vaultPath: "/private/OtherVault" });
		expect(service.read).toHaveBeenCalledOnce();
		await act(async () => old.resolve({ revision: "7", route: paperA }));
		expect(service.read.mock.calls[1]).toEqual(["/private/OtherVault"]);
		expect(service.restore).toHaveBeenCalledExactlyOnceWith(paperB);
		expect(visibleRoute()).toEqual(paperB);
		await advance(1000);
		expect(service.save).not.toHaveBeenCalled();
	});
	it("stops permanently on a CAS error with one toast and no automatic overwrite or retry", async () => {
		await render();
		service.save.mockRejectedValueOnce(new Error("mobile_route_conflict"));
		await navigate(paperA);
		await advance();
		expect(service.error).toHaveBeenCalledExactlyOnceWith("route.saveFailed", {
			description: "mobile_route_conflict",
		});
		await navigate(paperB);
		await advance(1000);
		await act(async () => window.dispatchEvent(new Event("pagehide")));
		expect(service.save).toHaveBeenCalledOnce();
		expect(service.read).toHaveBeenCalledOnce();
		expect(service.error).toHaveBeenCalledOnce();
	});
	it("does not overwrite corrupt route data after the initial read fails", async () => {
		service.read.mockRejectedValueOnce(new Error("mobile_route_corrupt"));
		await render();
		await navigate(paperA);
		await advance(1000);
		await act(async () => window.dispatchEvent(new Event("pagehide")));
		expect(service.save).not.toHaveBeenCalled();
		expect(service.read).toHaveBeenCalledOnce();
		expect(service.error).toHaveBeenCalledExactlyOnceWith(
			"route.restoreFailed",
			{ description: "mobile_route_corrupt" },
		);
	});
	it("flushes the latest route on pagehide before the debounce timer", async () => {
		await render();
		await navigate(paperA);
		expect(service.save).not.toHaveBeenCalled();
		await act(async () => window.dispatchEvent(new Event("pagehide")));
		expect(service.save).toHaveBeenCalledExactlyOnceWith(
			"/private/Vault",
			"0",
			paperA,
		);
		await advance(1000);
		expect(service.save).toHaveBeenCalledOnce();
	});
	it("flushes a newer route after the current save when visibility becomes hidden", async () => {
		await render();
		const first = deferred<MobileRouteSnapshot>();
		service.save.mockReturnValueOnce(first.promise);
		await navigate(paperA);
		await advance();
		await navigate(paperB);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		await act(async () =>
			document.dispatchEvent(new Event("visibilitychange")),
		);
		expect(service.save).toHaveBeenCalledOnce();
		await act(async () => first.resolve({ revision: "1", route: paperA }));
		expect(service.save.mock.calls[1]).toEqual(["/private/Vault", "1", paperB]);
	});
	it("cancels timers and drops late reads or save failures after unmount", async () => {
		const read = deferred<MobileRouteSnapshot>();
		service.read.mockReturnValueOnce(read.promise);
		await render();
		await act(async () => root.unmount());
		disposed = true;
		await act(async () => read.resolve({ revision: "8", route: paperA }));
		await advance(1000);
		expect(service.restore).not.toHaveBeenCalled();
		expect(service.save).not.toHaveBeenCalled();
		expect(service.error).not.toHaveBeenCalled();
	});
	it("persists only route fields and cancels an unsent debounce on unmount", async () => {
		await render();
		const withPrivateContent = Object.assign(
			{
				...paperA,
				pdf: { page: 8, zoom: 1.2, absolutePath: "/private/Vault/paper.pdf" },
			},
			{
				prompt: "secret question",
				notes: "private note",
				token: "secret credential",
			},
		);
		await navigate(withPrivateContent);
		await advance();
		const saved = service.save.mock.calls[0][2];
		expect(saved).toEqual({ ...paperA, pdf: { page: 8, zoom: 1.2 } });
		expect(JSON.stringify(saved)).not.toMatch(/secret|private|absolutePath/);
		await navigate(paperB);
		await act(async () => root.unmount());
		disposed = true;
		await advance(1000);
		expect(service.save).toHaveBeenCalledOnce();
	});
});
