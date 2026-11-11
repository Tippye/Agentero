import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperMetadata } from "@/lib/paper/types";

const media = vi.hoisted(() => ({
	find: vi.fn(
		async () => "/private/Vault/papers/example/example.pdf" as string | null,
	),
	read: vi.fn(async () => new ArrayBuffer(8) as ArrayBuffer | null),
	remote: vi.fn(() => ({
		pdfUrl: "https://example.org/paper.pdf",
		htmlUrl: null,
	})),
}));
vi.mock("@/lib/paper/media", () => ({
	findLocalPdfPath: media.find,
	localFileToArrayBuffer: media.read,
	paperRemoteAssetsFromMetadata: media.remote,
}));

import { loadMobilePaperPdf, mobilePaperPaths } from "@/lib/mobile/paper-files";

const paper = { id: "example", path: "papers/example" } as PaperMetadata;

beforeEach(() => {
	vi.clearAllMocks();
	media.find.mockResolvedValue("/private/Vault/papers/example/example.pdf");
	media.read.mockResolvedValue(new ArrayBuffer(8));
});

describe("mobile local paper files", () => {
	it("passes true absolute paper and note paths to shared persistence", () => {
		expect(mobilePaperPaths("/private/Vault/", paper)).toEqual({
			paperAbsPath: "/private/Vault/papers/example",
			paperRelPath: "papers/example",
			notesPath: "/private/Vault/papers/example/NOTES.md",
		});
	});

	it.each([
		undefined,
		"../other",
		"papers/../other",
		"/papers/example",
		"papers/a//b",
		"papers/a/./b",
		"papers/a/../../other",
	])("rejects malformed catalog paths (%s)", (path) => {
		expect(() =>
			mobilePaperPaths("/private/Vault", { ...paper, path }),
		).toThrow("Invalid paper path");
	});

	it("reads local bytes first even when a remote URL exists and the device is offline", async () => {
		const result = await loadMobilePaperPdf("/private/Vault", paper);
		expect(result.bytes?.byteLength).toBe(8);
		expect(result.source).toBeNull();
		expect(media.find).toHaveBeenCalledWith("/private/Vault/papers/example");
		expect(media.remote).not.toHaveBeenCalled();
	});

	it("uses the metadata URL only after no readable local PDF remains", async () => {
		media.read.mockResolvedValue(null);
		expect(await loadMobilePaperPdf("/private/Vault", paper)).toEqual({
			bytes: null,
			source: "https://example.org/paper.pdf",
		});
		media.find.mockResolvedValue(null);
		media.read.mockClear();
		await loadMobilePaperPdf("/private/Vault", paper);
		expect(media.read).not.toHaveBeenCalled();
	});
});
