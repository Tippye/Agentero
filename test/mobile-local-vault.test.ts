import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	appDataDir: vi.fn(async () => "/private/app-data/"),
	exists: vi.fn(async () => false),
	create: vi.fn(async () => ({ ok: true, data: {} })),
	ensure: vi.fn(async () => ({ ok: true, data: {} })),
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: native.appDataDir }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: native.exists }));
vi.mock("@/lib/core/bindings", () => ({
	commands: { vaultCreate: native.create, vaultEnsure: native.ensure },
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

import { openMobileVault } from "@/lib/mobile/local-vault";

beforeEach(() => {
	vi.clearAllMocks();
	native.exists.mockResolvedValue(false);
	native.create.mockResolvedValue({ ok: true, data: {} });
	native.ensure.mockResolvedValue({ ok: true, data: {} });
});

describe("mobile app-private Vault", () => {
	it("creates under appDataDir and ensures the scaffold before opening", async () => {
		expect(await openMobileVault("zh-CN")).toBe("/private/app-data/Vault");
		expect(native.create).toHaveBeenCalledWith(
			"/private/app-data/Vault",
			"zh-CN",
		);
		expect(native.ensure).toHaveBeenCalledWith(
			"/private/app-data/Vault",
			"zh-CN",
		);
		expect(native.create.mock.invocationCallOrder[0]).toBeLessThan(
			native.ensure.mock.invocationCallOrder[0],
		);
	});

	it("shares an in-flight open across StrictMode mounts and preserves an existing vault", async () => {
		native.exists.mockResolvedValue(true);
		const first = openMobileVault("en");
		expect(openMobileVault("en")).toBe(first);
		await first;
		expect(native.create).not.toHaveBeenCalled();
		expect(native.ensure).toHaveBeenCalledTimes(1);
	});

	it("does not report success when ensure fails and permits retry", async () => {
		native.ensure.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(openMobileVault("en")).rejects.toThrow("storage unavailable");
		expect(await openMobileVault("en")).toBe("/private/app-data/Vault");
		expect(native.ensure).toHaveBeenCalledTimes(2);
	});

	it("does not continue after a failed creation", async () => {
		native.create.mockRejectedValueOnce(new Error("disk full"));
		await expect(openMobileVault("en")).rejects.toThrow("disk full");
		expect(native.ensure).not.toHaveBeenCalled();
	});
});
