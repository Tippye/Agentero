import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import viewer from "../src/i18n/locales/en/viewer.json";

const native = vi.hoisted(() => ({ save: vi.fn(), writeFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: native.writeFile }));

import { exportMobileInkPdf } from "../src/lib/mobile/export-pdf";

beforeEach(async () => {
	vi.clearAllMocks();
	native.writeFile.mockResolvedValue(undefined);
	await i18n.init({
		lng: "en",
		resources: { en: { viewer } },
		initImmediate: false,
	});
});

const bytes = new TextEncoder().encode("%PDF-1.7\nexported copy");
const paper = "/private/app/Vault/papers/paper-1";

describe("native mobile annotated PDF save boundary", () => {
	it("cancelling the picker does not write a file", async () => {
		native.save.mockResolvedValue(null);
		await exportMobileInkPdf(bytes, "Paper.pdf", paper);
		expect(native.writeFile).not.toHaveBeenCalled();
	});

	it("passes Android SAF content URIs unchanged to the official filesystem plugin", async () => {
		const destination =
			"content://com.android.externalstorage.documents/document/primary%3ADownload%2FPaper.pdf";
		native.save.mockResolvedValue(destination);
		await exportMobileInkPdf(bytes, "Paper.pdf", paper);
		expect(native.writeFile).toHaveBeenCalledWith(destination, bytes);
	});

	it("preserves iOS security-scoped file URLs and propagates failed writes", async () => {
		const destination = "file:///private/Documents/Shared%20Paper.pdf";
		const failure = new Error("Provider no longer grants access");
		native.save.mockResolvedValue(destination);
		native.writeFile.mockRejectedValueOnce(failure);
		await expect(exportMobileInkPdf(bytes, "Paper.pdf", paper)).rejects.toBe(
			failure,
		);
		expect(native.writeFile).toHaveBeenCalledWith(destination, bytes);
	});

	it("rejects a chosen path inside the original paper, including encoded traversal", async () => {
		native.save.mockResolvedValue(
			"file:///private/app/Vault/papers/paper-1/source/..%2Fsource/original.pdf",
		);
		await expect(exportMobileInkPdf(bytes, "Paper.pdf", paper)).rejects.toThrow(
			"outside the original paper folder",
		);
		expect(native.writeFile).not.toHaveBeenCalled();
	});

	it("supplies a bounded unique basename, never a title-controlled staging path", async () => {
		native.save.mockResolvedValue(null);
		await exportMobileInkPdf(
			bytes,
			`../資料/${"文".repeat(200)}\u0000.pdf`,
			paper,
		);
		const name = native.save.mock.calls[0][0].defaultPath as string;
		expect(name).not.toMatch(/[\\/]/);
		expect(name).not.toContain("\u0000");
		expect(name).not.toMatch(/^\./);
		expect(new TextEncoder().encode(name).length).toBeLessThan(200);
		expect(name).toMatch(/-annotated-[0-9a-f-]{36}\.pdf$/);
		await exportMobileInkPdf(bytes, "Paper.pdf", paper);
		expect(native.save.mock.calls[1][0].defaultPath).not.toBe(name);
	});
});
