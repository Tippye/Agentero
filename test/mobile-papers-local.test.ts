// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStateEvent } from "@/lib/core/bindings";
import type { PaperMetadata } from "@/lib/paper/types";

const io = vi.hoisted(() => ({
	list: vi.fn(
		async (_vault: string) =>
			[{ id: "local", path: "papers/local" }] as PaperMetadata[],
	),
	rescan: vi.fn(async (_vault: string) => 1),
	error: vi.fn(),
	sync: null as ((event: { payload: SyncStateEvent }) => void) | null,
	off: vi.fn(),
}));
vi.mock("@/lib/paper/api", () => ({
	listPapers: io.list,
	rescanPapers: io.rescan,
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: io.error }));
vi.mock("@/lib/core/bindings", () => ({
	events: {
		syncState: {
			listen: async (callback: typeof io.sync) => {
				io.sync = callback;
				return io.off;
			},
		},
	},
}));

import { useMobilePapers } from "@/components/mobile/hooks/use-mobile-papers";

let root: ReturnType<typeof createRoot>;
let snapshot: ReturnType<typeof useMobilePapers>;
function Host({ path }: { path: string | null }) {
	snapshot = useMobilePapers({ vaultPath: path });
	return null;
}
const render = async (path: string | null) => {
	await act(async () => {
		root.render(createElement(Host, { path }));
	});
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	io.list.mockResolvedValue([
		{ id: "local", path: "papers/local" },
	] as PaperMetadata[]);
	io.rescan.mockResolvedValue(1);
	root = createRoot(document.createElement("div"));
});
afterEach(async () => {
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});

describe("local mobile catalog refresh", () => {
	it("rescans on open, foreground, and this Vault's completed sync before listing papers", async () => {
		await render(null);
		expect(io.list).not.toHaveBeenCalled();
		await render("/private/Vault");
		expect(snapshot.papers[0]?.id).toBe("local");
		expect(io.rescan).toHaveBeenCalledWith("/private/Vault");
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(io.rescan).toHaveBeenCalledTimes(2);
		io.rescan.mockImplementationOnce(async () => {
			io.list.mockResolvedValue([
				{ id: "synced", path: "papers/synced" },
			] as PaperMetadata[]);
			return 1;
		});
		await act(async () => {
			io.sync?.({ payload: { vaultPath: "/other", status: "idle" } });
		});
		expect(io.rescan).toHaveBeenCalledTimes(2);
		await act(async () => {
			io.sync?.({ payload: { vaultPath: "/private/Vault", status: "idle" } });
		});
		expect(io.list).toHaveBeenCalledTimes(3);
		expect(io.rescan).toHaveBeenCalledTimes(3);
		expect(snapshot.papers[0]?.id).toBe("synced");
	});

	it("retains the last successful library when a foreground rescan fails", async () => {
		await render("/private/Vault");
		io.rescan.mockRejectedValueOnce(new Error("storage busy"));
		await act(async () => {
			await snapshot.refresh(true);
		});
		expect(snapshot.papers[0]?.id).toBe("local");
		expect(snapshot.loading).toBe(false);
		expect(io.error).toHaveBeenCalledWith("storage busy");
	});

	it("does not let a previous Vault's in-flight result replace the active catalog", async () => {
		let release: (papers: PaperMetadata[]) => void = () => {};
		io.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		await render("/private/old");
		await render("/private/new");
		await act(async () => {
			release([{ id: "stale" }] as PaperMetadata[]);
		});
		expect(snapshot.papers[0]?.id).toBe("local");
	});
});
