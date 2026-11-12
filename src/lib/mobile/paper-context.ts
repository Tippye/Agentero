import { appCacheDir, join } from "@tauri-apps/api/path";
import { lstat, mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import type { PromptImage } from "@/lib/agent";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

/** Local location retained for a region reference; never a remote filesystem path. */
export type MobilePaperRegionSource = {
	id: string;
	paperId: string;
	title: string;
	page: number;
	region: PdfAskNormalizedRect;
};

/** An in-memory, unsent crop. Selecting a region grants no remote write authority. */
export type MobilePaperRegionContext = MobilePaperRegionSource & {
	image: PromptImage;
};

export const MAX_REGION_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_REGION_IMAGE_EDGE = 1600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedRegion(region: PdfAskNormalizedRect): PdfAskNormalizedRect {
	const { x, y, w, h } = region;
	if (
		![x, y, w, h].every(Number.isFinite) ||
		x < 0 ||
		y < 0 ||
		w <= 0 ||
		h <= 0 ||
		x + w > 1 + 1e-9 ||
		y + h > 1 + 1e-9
	)
		throw new Error("Invalid paper region");
	return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

/** Capture metadata now; later paper selection must not retitle an earlier crop. */
export function createPaperRegionContext(
	paper: { id: string; title: string },
	draft: { page: number; region: PdfAskNormalizedRect; image: PromptImage },
): MobilePaperRegionContext {
	if (
		!paper.id ||
		!Number.isInteger(draft.page) ||
		draft.page < 1 ||
		draft.page > 0xffffffff
	)
		throw new Error("Invalid paper reference");
	const context = {
		id: crypto.randomUUID(),
		paperId: paper.id,
		title: Array.from(
			paper.title
				.normalize("NFC")
				.replace(/\p{Cc}/gu, " ")
				.trim(),
		)
			.slice(0, 512)
			.join(""),
		page: draft.page,
		region: checkedRegion(draft.region),
		image: { data: draft.image.data, mimeType: draft.image.mimeType },
	};
	// Bound memory and preview decoding before retaining a crop in the shell.
	regionImageBytes(context, MAX_REGION_IMAGE_BYTES);
	return context;
}

/** Validate a bounded PNG envelope; decoding never accepts data URLs or SVG. */
export function regionImageBytes(
	context: MobilePaperRegionContext,
	maxBytes: number,
): Uint8Array {
	const image = context.image;
	const limit = Math.min(MAX_REGION_IMAGE_BYTES, maxBytes);
	if (
		!Number.isFinite(limit) ||
		limit < 33 ||
		!UUID.test(context.id) ||
		image.mimeType !== "image/png"
	)
		throw new Error("Invalid region image");
	checkedRegion(context.region);
	const data = image.data;
	if (
		typeof data !== "string" ||
		data.length > Math.ceil(limit / 3) * 4 ||
		data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(data)
	)
		throw new Error("Invalid region image encoding or size");
	const decoded = atob(data);
	if (decoded.length < 33 || decoded.length > limit)
		throw new Error("Region image exceeds the attachment limit");
	const bytes = Uint8Array.from(decoded, (character) =>
		character.charCodeAt(0),
	);
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (
		!signature.every((value, index) => bytes[index] === value) ||
		bytes[12] !== 73 ||
		bytes[13] !== 72 ||
		bytes[14] !== 68 ||
		bytes[15] !== 82
	)
		throw new Error("Region image must be a PNG");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16),
		height = view.getUint32(20);
	if (
		view.getUint32(8) !== 13 ||
		width === 0 ||
		height === 0 ||
		width > MAX_REGION_IMAGE_EDGE ||
		height > MAX_REGION_IMAGE_EDGE
	)
		throw new Error("Region image dimensions exceed the crop limit");
	return bytes;
}

/** Stage only after explicit send, under the existing native upload grant roots. */
export async function stagePaperRegionImage(
	context: MobilePaperRegionContext,
	maxBytes: number,
): Promise<{ path: string; remove: () => Promise<void> }> {
	const bytes = regionImageBytes(context, maxBytes);
	const root = await appCacheDir();
	if (!root) throw new Error("Application cache is unavailable");
	const directory = await join(root, "remote-region-drafts");
	await mkdir(directory, { recursive: true });
	const info = await lstat(directory);
	if (!info.isDirectory || info.isSymlink)
		throw new Error("Region staging directory is not private storage");
	const name = `region-${crypto.randomUUID()}.png`;
	const path = await join(directory, name);
	// Exclusive creation prevents following or overwriting an existing leaf.
	// On an uncertain write failure the uniquely named cache entry is retained;
	// a later send uses a new name and cannot destroy another file.
	await writeFile(path, bytes, { createNew: true });
	let removed = false;
	return {
		path,
		remove: async () => {
			if (removed) return;
			const parent = await lstat(directory);
			if (!parent.isDirectory || parent.isSymlink)
				throw new Error("Region staging directory changed");
			// Check the owned leaf again; never recursively remove a cache path.
			const current = await lstat(path);
			if (
				!current.isFile ||
				current.isSymlink ||
				current.size !== bytes.byteLength
			)
				throw new Error("Region staging entry changed");
			await remove(path);
			removed = true;
		},
	};
}
