/**
 * Per-paper "resume reading" position (last visited page), kept in localStorage
 * so reopening a PDF returns to where you left off. Keyed by a stable paper
 * path; loose PDFs without a paper path are not tracked.
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import type { PdfReloadPosition } from "@/lib/pdf/reload-position";
import { PDF_ZOOM_MAX, PDF_ZOOM_MIN } from "@/lib/pdf/zoom";

/** Portable route state; physical reloads retain their more precise page anchor. */
export type PdfReadingSnapshot = { page: number; zoom: number };
export type PdfReadingSnapshotSeed = {
	baseDocId: string;
	position: { current: PdfReloadPosition | null };
};
export function normalizePdfReadingSnapshot(
	snapshot: PdfReadingSnapshot | null | undefined,
): PdfReadingSnapshot | null {
	if (
		!snapshot ||
		!Number.isFinite(snapshot.page) ||
		!Number.isFinite(snapshot.zoom) ||
		snapshot.page < 1 ||
		snapshot.zoom <= 0
	)
		return null;
	return {
		page: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(snapshot.page)),
		zoom: Math.max(PDF_ZOOM_MIN, Math.min(PDF_ZOOM_MAX, snapshot.zoom)),
	};
}
/** Re-renders never reseed; a new paper owns a different ref than old cleanup. */
export function seedPdfReadingSnapshot(
	previous: PdfReadingSnapshotSeed | null,
	baseDocId: string,
	initial: PdfReadingSnapshot | null | undefined,
): PdfReadingSnapshotSeed {
	if (previous?.baseDocId === baseDocId) return previous;
	const snapshot = normalizePdfReadingSnapshot(initial);
	return {
		baseDocId,
		position: {
			current: snapshot
				? {
						...snapshot,
						documentId: `${baseDocId}::initial-reading-snapshot`,
						x: 0,
						y: 0,
						alignX: 0,
						alignY: 0,
					}
				: null,
		},
	};
}

const KEY = "agentero-pdf-reading-pos";

function readMap(): Record<string, number> {
	const parsed = readJsonStorage<unknown>(KEY, {});
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, number>)
		: {};
}

/** Last read 1-based page for a paper key, or 0 when none worth restoring. */
export function readReadingPage(key: string): number {
	const n = readMap()[key];
	return typeof n === "number" && n > 1 ? Math.floor(n) : 0;
}

export function writeReadingPage(key: string, page: number): void {
	const map = readMap();
	if (page > 1) map[key] = Math.floor(page);
	else delete map[key];
	writeJsonStorage(KEY, map);
}
