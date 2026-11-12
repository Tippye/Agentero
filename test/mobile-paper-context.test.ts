import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	cache: vi.fn(),
	join: vi.fn(),
	mkdir: vi.fn(),
	lstat: vi.fn(),
	writeFile: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("@tauri-apps/api/path", () => ({
	appCacheDir: native.cache,
	join: native.join,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
	mkdir: native.mkdir,
	lstat: native.lstat,
	writeFile: native.writeFile,
	remove: native.remove,
}));

import {
	createPaperRegionContext,
	MAX_REGION_IMAGE_BYTES,
	type MobilePaperRegionContext,
	regionImageBytes,
	stagePaperRegionImage,
} from "@/lib/mobile/paper-context";

const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j94sAAAAASUVORK5CYII=";
const bytes = () =>
	Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
const directory = "/private/cache/remote-region-drafts";
const draft = () => ({
	page: 3,
	region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
	image: { data: png, mimeType: "image/png" },
});
const context = (): MobilePaperRegionContext => ({
	id: "00000000-0000-4000-8000-000000000001",
	paperId: "local-paper-id",
	title: "A paper",
	...draft(),
});
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));

beforeEach(() => {
	vi.resetAllMocks();
	native.cache.mockResolvedValue("/private/cache");
	native.join.mockImplementation(async (...parts: string[]) => parts.join("/"));
	native.mkdir.mockResolvedValue(undefined);
	native.writeFile.mockResolvedValue(undefined);
	native.remove.mockResolvedValue(undefined);
	native.lstat.mockImplementation(async (path: string) =>
		path === directory
			? { isDirectory: true, isFile: false, isSymlink: false }
			: {
					isDirectory: false,
					isFile: true,
					isSymlink: false,
					size: bytes().length,
				},
	);
});

describe("reviewed mobile paper region boundary", () => {
	it("captures immutable source metadata and bounded evidence without filesystem work", () => {
		const paper = {
			id: "local-paper-id",
			title: `../資料\u0000/${"文".repeat(600)}`,
		};
		const input = draft();
		const saved = createPaperRegionContext(paper, input);
		paper.title = "another paper";
		input.region.x = 0.9;
		input.image.data = "replaced";
		expect(saved).toMatchObject({
			paperId: "local-paper-id",
			page: 3,
			region: { x: 0.1 },
			image: { data: png },
		});
		expect(saved.title).not.toContain("\u0000");
		expect(Array.from(saved.title)).toHaveLength(512);
		expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(native.cache).not.toHaveBeenCalled();
		expect(native.writeFile).not.toHaveBeenCalled();
	});

	it.each([
		{ page: 0 },
		{ page: Number.NaN },
		{ page: 1.5 },
		{ page: 0x100000000 },
		{ region: { x: 0.9, y: 0, w: 0.2, h: 0.2 } },
		{ region: { x: 0, y: 0, w: 0, h: 0.2 } },
		{ region: { x: 0, y: 0, w: 0.2, h: Number.POSITIVE_INFINITY } },
	])("refuses invalid source coordinates before retaining or staging: %o", (patch) => {
		expect(() =>
			createPaperRegionContext(
				{ id: "paper", title: "Title" },
				{ ...draft(), ...patch },
			),
		).toThrow();
		expect(native.cache).not.toHaveBeenCalled();
	});

	it("enforces the exact negotiated byte limit before any native IO", async () => {
		expect(regionImageBytes(context(), bytes().length)).toEqual(bytes());
		await expect(
			stagePaperRegionImage(context(), bytes().length - 1),
		).rejects.toThrow();
		expect(native.cache).not.toHaveBeenCalled();
		expect(native.writeFile).not.toHaveBeenCalled();
	});

	it.each([
		{ image: { data: png, mimeType: "image/svg+xml" } },
		{ image: { data: `data:image/png;base64,${png}`, mimeType: "image/png" } },
		{ image: { data: `${png}!`, mimeType: "image/png" } },
		{
			image: {
				data: "A".repeat(Math.ceil(MAX_REGION_IMAGE_BYTES / 3) * 4 + 4),
				mimeType: "image/png",
			},
		},
		{ id: "../../paper.pdf" },
	])("refuses non-PNG, malformed or unbounded envelopes without filesystem authority", async (patch) => {
		await expect(
			stagePaperRegionImage({ ...context(), ...patch }, MAX_REGION_IMAGE_BYTES),
		).rejects.toThrow();
		expect(native.cache).not.toHaveBeenCalled();
	});

	it("bounds declared PNG dimensions even when the encoded header is tiny", async () => {
		const image = bytes();
		new DataView(image.buffer).setUint32(16, 1000000);
		await expect(
			stagePaperRegionImage(
				{ ...context(), image: { data: encode(image), mimeType: "image/png" } },
				1024,
			),
		).rejects.toThrow("dimensions");
		expect(native.cache).not.toHaveBeenCalled();
	});

	it("uses a unique private basename with exclusive creation and cleans only its own leaf", async () => {
		const input = { ...context(), title: "../../Vault/papers/original.pdf" };
		const first = await stagePaperRegionImage(input, 1024);
		const second = await stagePaperRegionImage(input, 1024);
		expect(first.path).toMatch(
			/^\/private\/cache\/remote-region-drafts\/region-[0-9a-f-]{36}\.png$/,
		);
		expect(first.path).not.toBe(second.path);
		expect(native.writeFile).toHaveBeenCalledWith(first.path, bytes(), {
			createNew: true,
		});
		expect(native.remove).not.toHaveBeenCalled();
		await first.remove();
		await first.remove();
		expect(native.remove).toHaveBeenCalledExactlyOnceWith(first.path);
	});

	it("refuses symlink staging directories and never writes an arbitrary target", async () => {
		native.lstat.mockResolvedValue({ isDirectory: true, isSymlink: true });
		await expect(stagePaperRegionImage(context(), 1024)).rejects.toThrow(
			"private storage",
		);
		expect(native.writeFile).not.toHaveBeenCalled();
		expect(native.remove).not.toHaveBeenCalled();
	});

	it("retains an uncertain write result rather than deleting a possible preexisting entry", async () => {
		const failure = new Error("provider write interrupted");
		native.writeFile.mockRejectedValueOnce(failure);
		await expect(stagePaperRegionImage(context(), 1024)).rejects.toBe(failure);
		expect(native.remove).not.toHaveBeenCalled();
	});

	it("refuses cleanup after the directory or leaf has become a link", async () => {
		const staged = await stagePaperRegionImage(context(), 1024);
		native.lstat.mockResolvedValueOnce({ isDirectory: true, isSymlink: true });
		await expect(staged.remove()).rejects.toThrow("directory changed");
		native.lstat
			.mockResolvedValueOnce({ isDirectory: true, isSymlink: false })
			.mockResolvedValueOnce({
				isFile: true,
				isSymlink: true,
				size: bytes().length,
			});
		await expect(staged.remove()).rejects.toThrow("entry changed");
		expect(native.remove).not.toHaveBeenCalled();
	});
});
