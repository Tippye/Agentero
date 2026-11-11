import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	mkdir: vi.fn(async () => {}),
	write: vi.fn(async () => {}),
	remove: vi.fn(async () => {}),
	import: vi.fn(async () => ({
		status: "ok",
		data: { ok: true, data: { papers: [{}], errors: [] } },
	})),
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: { paperImportLocalPdf: io.import },
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/vault/fs", () => ({
	createVaultDirectory: io.mkdir,
	writeVaultBytes: io.write,
	removeVaultPath: io.remove,
}));

import { importMobilePdfs } from "@/lib/mobile/import-pdf";

const file = {
	name: "Offline research.pdf",
	arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
} as File;

beforeEach(() => vi.clearAllMocks());

describe("mobile browser PDF import", () => {
	it("stages privately and delegates the real import without OCR or network recognition", async () => {
		expect(await importMobilePdfs("/private/Vault", [file])).toEqual({
			imported: 1,
			errors: [],
		});
		const staging = io.mkdir.mock.calls[0][0];
		expect(staging).toMatch(
			/^\/private\/Vault\/\.agentero\/import-tmp\/[\w-]+$/,
		);
		expect(io.write).toHaveBeenCalledWith(
			`${staging}/0.pdf`,
			new Uint8Array([37, 80, 68, 70]),
		);
		expect(io.import).toHaveBeenCalledWith({
			vaultPath: "/private/Vault",
			parentDir: "papers",
			filePaths: [],
			recognizeSync: false,
			entries: [{ filePath: `${staging}/0.pdf`, title: "Offline research" }],
		});
		expect(io.remove.mock.calls.map(([path]) => path)).toEqual([
			`${staging}/0.pdf`,
			staging,
		]);
	});

	it("cleans only its unique staging directory when the importer rejects", async () => {
		io.import.mockRejectedValueOnce(new Error("catalog unavailable"));
		await expect(importMobilePdfs("/private/Vault", [file])).rejects.toThrow(
			"catalog unavailable",
		);
		expect(io.remove).toHaveBeenCalledExactlyOnceWith(
			io.mkdir.mock.calls[0][0],
		);
	});
});
