import type { PdfGlyphSlim, PdfPageGeometry, Rect } from "@embedpdf/models";

/**
 * PDFium glyph ink geometry shared by the page layers.
 *
 * Text selection was removed from the viewer, so this module only keeps the
 * pieces other features still use: tight ink rects per glyph (sentence hover
 * washes) and merging adjacent glyph rects into per-line bands.
 */

type TextFragment = {
	rect: Rect;
	charCount: number;
	averageGlyphWidth: number;
};

const GLYPH_FLAG_SPACE = 1;
const GLYPH_FLAG_EMPTY = 2;
const MAX_GLYPH_GAP_FACTOR = 2.5;
const MIN_VERTICAL_OVERLAP = 0.5;

function isFinitePositive(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value);
}

function glyphRect(glyph: PdfGlyphSlim): Rect | null {
	if (glyph.flags === GLYPH_FLAG_SPACE || glyph.flags === GLYPH_FLAG_EMPTY) {
		return null;
	}

	const { tightX, tightY, tightWidth, tightHeight } = glyph;
	if (
		isFiniteNumber(tightX) &&
		isFiniteNumber(tightY) &&
		isFinitePositive(tightWidth) &&
		isFinitePositive(tightHeight)
	) {
		return {
			origin: { x: tightX, y: tightY },
			size: { width: tightWidth, height: tightHeight },
		};
	}

	const { x, y, width, height } = glyph;

	if (
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		!isFinitePositive(width) ||
		!isFinitePositive(height)
	) {
		return null;
	}

	return {
		origin: { x, y },
		size: { width, height },
	};
}

export { glyphRect as selectionGlyphInkRect };

/** Complete-page ink metrics shared by every partial selection on this geometry. */
const pageInkRects = new WeakMap<PdfPageGeometry, Rect[]>();
export function pageSelectionInkRects(
	geometry: PdfPageGeometry | undefined,
): Rect[] {
	if (!geometry) return [];
	const cached = pageInkRects.get(geometry);
	if (cached) return cached;
	const rects = geometry.runs.flatMap((run) =>
		run.glyphs.flatMap((glyph) => {
			const rect = glyphRect(glyph);
			return rect ? [rect] : [];
		}),
	);
	pageInkRects.set(geometry, rects);
	return rects;
}

function unionRects(first: Rect, second: Rect): Rect {
	const left = Math.min(first.origin.x, second.origin.x);
	const top = Math.min(first.origin.y, second.origin.y);
	const right = Math.max(
		first.origin.x + first.size.width,
		second.origin.x + second.size.width,
	);
	const bottom = Math.max(
		first.origin.y + first.size.height,
		second.origin.y + second.size.height,
	);
	return {
		origin: { x: left, y: top },
		size: { width: right - left, height: bottom - top },
	};
}

export function unionRectsAll(rects: Rect[]): Rect | null {
	if (!rects.length) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const r of rects) {
		minX = Math.min(minX, r.origin.x);
		minY = Math.min(minY, r.origin.y);
		maxX = Math.max(maxX, r.origin.x + r.size.width);
		maxY = Math.max(maxY, r.origin.y + r.size.height);
	}
	return {
		origin: { x: minX, y: minY },
		size: { width: maxX - minX, height: maxY - minY },
	};
}

function verticalOverlap(first: Rect, second: Rect): number {
	const top = Math.max(first.origin.y, second.origin.y);
	const bottom = Math.min(
		first.origin.y + first.size.height,
		second.origin.y + second.size.height,
	);
	return (
		Math.max(0, bottom - top) / Math.min(first.size.height, second.size.height)
	);
}

function sameVisualLine(first: Rect, second: Rect): boolean {
	return verticalOverlap(first, second) >= MIN_VERTICAL_OVERLAP;
}

function mergeLineFragments(fragments: TextFragment[]): Rect[] {
	const merged: TextFragment[] = [];

	for (const fragment of fragments) {
		const previous = merged.at(-1);
		if (!previous || !sameVisualLine(previous.rect, fragment.rect)) {
			merged.push(fragment);
			continue;
		}

		const gap =
			fragment.rect.origin.x -
			(previous.rect.origin.x + previous.rect.size.width);
		const maximumGap =
			Math.max(previous.averageGlyphWidth, fragment.averageGlyphWidth) *
			MAX_GLYPH_GAP_FACTOR;
		if (gap > maximumGap || gap < -maximumGap) {
			merged.push(fragment);
			continue;
		}

		const charCount = previous.charCount + fragment.charCount;
		previous.averageGlyphWidth =
			(previous.averageGlyphWidth * previous.charCount +
				fragment.averageGlyphWidth * fragment.charCount) /
			charCount;
		previous.charCount = charCount;
		previous.rect = unionRects(previous.rect, fragment.rect);
	}

	return merged.map((fragment) => fragment.rect);
}

/** Turn matched glyphs in reading order into continuous bands on each line. */
export function mergeTightGlyphRects(rects: readonly Rect[]): Rect[] {
	return mergeLineFragments(
		rects.map((rect) => ({
			rect,
			charCount: 1,
			averageGlyphWidth: rect.size.width,
		})),
	);
}
