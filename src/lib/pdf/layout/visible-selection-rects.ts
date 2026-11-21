/**
 * Client-rect bands for DOM text inside a page.
 *
 * Text selection in the PDF viewer was removed; these helpers survive for the
 * translation sentence pairing (layout-element hover) and the reflow element
 * sentence bands, which still need a DOM `Range` folded into per-line boxes.
 */

import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

export type ClientRectLike = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export type VisibleSelectionPage = {
	/** 0-based page index, same as EmbedPDF. */
	pageIndex: number;
	rects: PdfAskNormalizedRect[];
};

const MIN_CLIENT_PX = 0.5;
/** Same line rule as the English glyph highlight (`selection-appearance.ts`). */
const MIN_VERTICAL_OVERLAP = 0.5;
/** Justification and sentence-span seams stay inside one band; a column gutter does not. */
const MAX_GAP_FACTOR = 2.5;

function verticalOverlapRatio(
	first: ClientRectLike,
	second: ClientRectLike,
): number {
	const top = Math.max(first.top, second.top);
	const bottom = Math.min(first.top + first.height, second.top + second.height);
	const overlap = Math.max(0, bottom - top);
	const minHeight = Math.min(first.height, second.height);
	return minHeight > 0 ? overlap / minHeight : 0;
}

/**
 * Join selection fragments that sit on one visual line.
 *
 * A translation paragraph is split into sentence spans, and justified CJK
 * yields a client rect per character. Native `::selection` paints each of
 * those separately, so a drag looks like disconnected blocks. This unions
 * client rects on the same line, in document order.
 */
export function mergeClientRectsIntoLines(
	rects: readonly ClientRectLike[],
): ClientRectLike[] {
	const merged: ClientRectLike[] = [];
	for (const rect of rects) {
		if (rect.width < MIN_CLIENT_PX || rect.height < MIN_CLIENT_PX) continue;
		const previous = merged.at(-1);
		const glyph = Math.min(
			rect.width,
			rect.height,
			previous?.height ?? rect.height,
		);
		const maximumGap = Math.max(glyph, 1) * MAX_GAP_FACTOR;
		const gap = previous
			? rect.left - (previous.left + previous.width)
			: Number.POSITIVE_INFINITY;
		if (
			!previous ||
			verticalOverlapRatio(previous, rect) < MIN_VERTICAL_OVERLAP ||
			gap > maximumGap
		) {
			merged.push({
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
			});
			continue;
		}
		const left = Math.min(previous.left, rect.left);
		const top = Math.min(previous.top, rect.top);
		const right = Math.max(
			previous.left + previous.width,
			rect.left + rect.width,
		);
		const bottom = Math.max(
			previous.top + previous.height,
			rect.top + rect.height,
		);
		previous.left = left;
		previous.top = top;
		previous.width = right - left;
		previous.height = bottom - top;
	}
	return separateStackedLines(merged);
}

/** Keep a partial DOM selection at the full text line's vertical extent. */
export function fullLineSelectionRects(
	selected: readonly ClientRectLike[],
	fullLines: readonly ClientRectLike[],
): ClientRectLike[] {
	return selected.map((rect) => {
		const line = fullLines
			.filter(
				(line) =>
					verticalOverlapRatio(rect, line) >= MIN_VERTICAL_OVERLAP &&
					rect.left < line.left + line.width &&
					rect.left + rect.width > line.left,
			)
			.sort(
				(a, b) => Math.abs(a.top - rect.top) - Math.abs(b.top - rect.top),
			)[0];
		return line ? { ...rect, top: line.top, height: line.height } : { ...rect };
	});
}

/** Complete paragraph line boxes for the sentences inside a DOM range. */
export function translatedSelectionLineRects(
	root: HTMLElement,
	range: Range,
): ClientRectLike[] {
	const fullLines = Array.from(
		root.querySelectorAll<HTMLElement>("[data-layout-item]"),
	)
		.filter((item) => range.intersectsNode(item))
		.flatMap((item) => {
			const whole = document.createRange();
			whole.selectNodeContents(item);
			return mergeClientRectsIntoLines(Array.from(whole.getClientRects()));
		});
	return fullLineSelectionRects(
		mergeClientRectsIntoLines(Array.from(range.getClientRects())),
		fullLines,
	);
}

/**
 * Reflow gives every character the font's full height, which is taller than
 * the gap to the next baseline. Each line stays its own band, but the two
 * bands share a strip. Split that strip so the highlight is not painted twice.
 */
function separateStackedLines(rects: ClientRectLike[]): ClientRectLike[] {
	const lines = rects.map((rect) => ({ ...rect }));
	for (let index = 1; index < lines.length; index += 1) {
		const previous = lines[index - 1];
		const current = lines[index];
		if (!previous || !current) continue;
		const overlap = previous.top + previous.height - current.top;
		const minHeight = Math.min(previous.height, current.height);
		if (overlap <= 0 || minHeight <= 0) continue;
		if (overlap >= minHeight * MIN_VERTICAL_OVERLAP) continue;
		const shared =
			Math.min(previous.left + previous.width, current.left + current.width) -
			Math.max(previous.left, current.left);
		if (shared <= 0) continue;
		const mid = current.top + overlap / 2;
		const bottom = current.top + current.height;
		previous.height = mid - previous.top;
		current.top = mid;
		current.height = bottom - mid;
	}
	return lines;
}
