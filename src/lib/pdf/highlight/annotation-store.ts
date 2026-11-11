import type {
	PdfAnnotationObject,
	PdfHighlightAnnoObject,
} from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import type { TrackedAnnotation } from "@embedpdf/plugin-annotation";
import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation/react";
import type { ApiError } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import { dedupeAnnotationItems } from "@/lib/pdf/highlight/annotation-items";
import {
	type HighlightColor,
	highlightColorFromHex,
} from "@/lib/pdf/highlight/palette";
import { sanitizeTranslatedRects } from "@/lib/pdf/highlight/translated-geometry";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import {
	ANNOTATIONS_JSON,
	MARKS_FOLDER,
	markSelfWrite,
} from "@/lib/pdf/selection/marks-io";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";
import { removeVaultFile, vaultPathExists } from "@/lib/vault/fs";

/**
 * Highlights/批注 are stored as EmbedPDF annotations (source of truth) in
 * `papers/<id>/marks/annotations.json` — the `exportAnnotations()` /
 * `importAnnotations()` transfer format. Ask/Translate stay as sibling
 * `marks/<id>.json` files. A legacy root-level `papers/<id>/annotations.json`
 * is migrated into `marks/` on first load.
 */
export const ANNOTATIONS_FILE = ANNOTATIONS_JSON;

/** In-memory fallback when not running under Tauri (browser dev). */
const memoryStore = new Map<string, AnnotationTransferItem[]>();

/** One viewer's working-copy base. Reads by other viewers must not update it. */
export type AnnotationFileBase = {
	path?: string;
	/** undefined until loaded; null means the canonical file was missing. */
	content?: string | null;
};

/** Canonical path: `papers/<id>/marks/annotations.json`. */
function annotationsPath(paperAbsPath: string): string {
	return joinVaultPath(
		joinVaultPath(paperAbsPath, MARKS_FOLDER),
		ANNOTATIONS_FILE,
	);
}

/** Pre-move path: `papers/<id>/annotations.json` (paper root). */
function legacyAnnotationsPath(paperAbsPath: string): string {
	return joinVaultPath(paperAbsPath, ANNOTATIONS_FILE);
}

async function removeFileIfExists(path: string): Promise<void> {
	try {
		await removeVaultFile(path);
	} catch {
		// Legacy cleanup is best effort; the canonical guarded save succeeded.
	}
}

async function readOptionalFile(path: string): Promise<string | null> {
	try {
		return await readVaultFile(path);
	} catch (error) {
		if (await vaultPathExists(path)) throw error;
		return null;
	}
}

/** Read exact canonical bytes without importing or rebasing any open viewer. */
export async function readAnnotationFileContent(
	paperAbsPath: string,
): Promise<string | null> {
	return readOptionalFile(annotationsPath(paperAbsPath));
}

/** The host sets this only after writing/reusing the exact conflict proposal. */
export function isPreservedAnnotationConflict(error: unknown): boolean {
	const details = (error as ApiError | null)?.details as
		| { conflictPreserved?: boolean }
		| undefined;
	return details?.conflictPreserved === true;
}

function parseAnnotationItems(raw: string): AnnotationTransferItem[] {
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) throw new Error("Invalid annotations file");
	return dedupeAnnotationItems(parsed as AnnotationTransferItem[]);
}

export async function loadAnnotationItems(
	paperAbsPath: string,
	base?: AnnotationFileBase,
): Promise<AnnotationTransferItem[]> {
	if (!paperAbsPath) return [];
	if (!isTauri()) {
		return dedupeAnnotationItems(memoryStore.get(paperAbsPath) ?? []);
	}

	const path = annotationsPath(paperAbsPath);
	const raw = await readOptionalFile(path);
	if (raw !== null) {
		// Corrupt/unsupported files must surface an error, never become an empty
		// working copy that a later export could save over the original bytes.
		const items = parseAnnotationItems(raw);
		if (base) Object.assign(base, { path, content: raw });
		return items;
	}
	const workingBase = base ?? {};
	const legacy = await readOptionalFile(legacyAnnotationsPath(paperAbsPath));
	if (legacy === null) {
		Object.assign(workingBase, { path, content: null });
		return [];
	}
	const items = parseAnnotationItems(legacy);
	Object.assign(workingBase, { path, content: null });
	// Migration also checks that canonical marks/ is still missing. A sync
	// arrival during this load is preserved rather than overwritten.
	await saveAnnotationItems(paperAbsPath, items, workingBase);
	return items;
}

export async function saveAnnotationItems(
	paperAbsPath: string,
	items: AnnotationTransferItem[],
	base?: AnnotationFileBase,
): Promise<void> {
	if (!paperAbsPath) return;
	const next = dedupeAnnotationItems(items);
	if (!isTauri()) {
		memoryStore.set(paperAbsPath, next);
		return;
	}
	const path = annotationsPath(paperAbsPath);
	if (base?.path !== path || base.content === undefined) {
		throw new Error("Annotations must be loaded before saving");
	}
	const content = `${JSON.stringify(next, null, 2)}\n`;
	markSelfWrite(path);
	await writeVaultFile(path, content, { expectedContent: base.content });
	// Advance only this viewer's base, only after a successful guarded save.
	// Conflict saves leave it stale so subsequent exports cannot erase sync data.
	base.content = content;
	// Drop legacy root copy if present so marks/ is the only location.
	await removeFileIfExists(legacyAnnotationsPath(paperAbsPath));
}

/** Call inside the per-paper save queue so export and its immutable base agree. */
export async function saveAnnotationSnapshot(
	paperAbsPath: string,
	exportSnapshot: () => Promise<AnnotationTransferItem[]>,
	base: AnnotationFileBase,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	if (!isCurrent()) return;
	const capturedBase = { ...base };
	const items = await exportSnapshot();
	if (!isCurrent()) return;
	await saveAnnotationItems(paperAbsPath, items, capturedBase);
	if (isCurrent()) Object.assign(base, capturedBase);
}

export async function hasAnnotationsFile(
	paperAbsPath: string,
): Promise<boolean> {
	if (!paperAbsPath) return false;
	if (!isTauri()) return memoryStore.has(paperAbsPath);
	for (const path of [
		annotationsPath(paperAbsPath),
		legacyAnnotationsPath(paperAbsPath),
	]) {
		try {
			await readVaultFile(path);
			return true;
		} catch {
			// try next
		}
	}
	return false;
}

export function isHighlightObject(
	obj: PdfAnnotationObject,
): obj is PdfHighlightAnnoObject {
	return obj.type === PdfAnnotationSubtype.HIGHLIGHT;
}

/**
 * EmbedPDF keeps a deleted annotation in `byUid` until an async commit purges
 * it, and `getAnnotations()` / `getAnnotationById()` still return it as
 * `commitState: "deleted"` in the meantime (or forever if the commit was
 * dropped). Rendering, hit testing and editors must treat those as gone.
 */
export function isLiveAnnotation(
	annotation: Pick<TrackedAnnotation, "commitState">,
): boolean {
	return annotation.commitState !== "deleted";
}

/** App-specific metadata round-tripped through the annotation `custom` field. */
export type HighlightCustom = {
	app?: string;
	paletteKey?: HighlightColor;
	quote?: string;
	/**
	 * Page-fraction boxes of the translated selection on this annotation's
	 * page. Absent for a highlight made on the English text layer.
	 */
	translatedRects?: PdfHighlight["translatedRects"];
};

export function highlightColorOf(obj: PdfHighlightAnnoObject): HighlightColor {
	const custom = (obj.custom ?? {}) as HighlightCustom;
	if (custom.paletteKey) return custom.paletteKey;
	return highlightColorFromHex(obj.strokeColor ?? obj.color);
}

export function highlightQuoteOf(obj: PdfHighlightAnnoObject): string {
	const custom = (obj.custom ?? {}) as HighlightCustom;
	return custom.quote?.trim() ?? "";
}

/** Build the PdfHighlight view model that the annotations panel + handle use. */
export function highlightViewFromObject(
	obj: PdfHighlightAnnoObject,
	paperPath: string,
): PdfHighlight {
	const iso = (d?: Date) =>
		d instanceof Date ? d.toISOString() : new Date().toISOString();
	const comment = obj.contents?.trim();
	const view: PdfHighlight = {
		version: 1,
		kind: "highlight",
		id: obj.id,
		paperPath,
		createdAt: iso(obj.created),
		updatedAt: iso(obj.modified ?? obj.created),
		page: obj.pageIndex + 1,
		rects: [],
		quote: highlightQuoteOf(obj),
		color: highlightColorOf(obj),
	};
	if (comment) view.comment = comment;
	const translated = sanitizeTranslatedRects(
		(obj.custom as HighlightCustom | undefined)?.translatedRects,
	);
	if (translated.length > 0) view.translatedRects = translated;
	return view;
}
