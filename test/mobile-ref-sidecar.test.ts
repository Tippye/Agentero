import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	mobile: true,
	list: vi.fn(),
	enqueue: vi.fn(),
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		paperRefsList: state.list,
		jobParseRefsEnqueue: state.enqueue,
	},
}));
vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => true,
	isMobileApp: () => state.mobile,
}));

import { loadPaperRefsReadOnly } from "@/lib/paper/refs";

beforeEach(() => {
	vi.clearAllMocks();
	state.mobile = true;
	state.list.mockResolvedValue({ ok: true, data: null });
	state.enqueue.mockResolvedValue({
		status: "ok",
		data: { ok: true, data: null },
	});
});

describe("mobile reference sidecars", () => {
	it("shows synchronized citations without scheduling local work", async () => {
		const sidecar = { schemaVersion: 1, citations: [{ id: "cite-1" }] };
		state.list.mockResolvedValue({ ok: true, data: sidecar });
		expect(await loadPaperRefsReadOnly("/private/Vault", "papers/a")).toEqual(
			sidecar,
		);
		expect(state.enqueue).not.toHaveBeenCalled();
	});

	it("leaves a missing mobile sidecar absent without invoking desktop parsing", async () => {
		expect(
			await loadPaperRefsReadOnly("/private/Vault", "papers/a"),
		).toBeNull();
		expect(state.list).toHaveBeenCalledWith({
			vaultPath: "/private/Vault",
			path: "papers/a",
		});
		expect(state.enqueue).not.toHaveBeenCalled();
	});

	it("retains desktop backfill for missing references", async () => {
		state.mobile = false;
		await loadPaperRefsReadOnly("/desktop/Vault", "papers/a");
		expect(state.enqueue).toHaveBeenCalledWith({
			vaultPath: "/desktop/Vault",
			path: "papers/a",
			force: false,
		});
	});
});
