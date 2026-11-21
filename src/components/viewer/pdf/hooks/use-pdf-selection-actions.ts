import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import { useCallback } from "react";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import type { PdfTextMarkupKind } from "@/lib/pdf/highlight/types";
import type { VisibleSelectionPage } from "@/lib/pdf/layout/visible-selection-rects";

/**
 * Quote-based note action.
 *
 * The PDF text selection toolbar was removed, so the only remaining caller is
 * the region/element selection path: framing a region or picking a layout
 * element opens the note editor, and committing that draft must create the
 * highlight plus its comment. Highlight colours, ask, add-to-chat, translate
 * and copy each live with their own owners
 * (`layout-element-actions.tsx`, `use-pdf-selection-translate`, …).
 */
export type UsePdfSelectionActionsOptions = {
	runAnnotationBatch: (action: () => void) => void;
	/** Highlights cluster writer. */
	createHighlights: (
		pages: FormattedSelection[],
		color: HighlightColor,
		quote: string,
		translatedPages?: readonly VisibleSelectionPage[],
		shape?: PdfTextMarkupKind,
	) => { pageIndex: number; id: string }[];
	/** Write the note body onto a freshly created highlight. */
	updateHighlightComment: (
		pageIndex: number,
		id: string,
		comment: string,
	) => void;
};

export type PdfSelectionActions = {
	/**
	 * Create a highlight + comment from a snapped note draft. Used by the
	 * region/element note editor so typing survives the page selection
	 * clearing.
	 */
	handleCommitSelectionNote: (
		draft: {
			pages: FormattedSelection[];
			quote: string;
			shape?: PdfTextMarkupKind;
			visiblePages?: readonly VisibleSelectionPage[];
		},
		comment: string,
	) => void;
};

export function usePdfSelectionActions({
	runAnnotationBatch,
	createHighlights,
	updateHighlightComment,
}: UsePdfSelectionActionsOptions): PdfSelectionActions {
	const handleCommitSelectionNote = useCallback(
		(
			draft: {
				pages: FormattedSelection[];
				quote: string;
				shape?: PdfTextMarkupKind;
				visiblePages?: readonly VisibleSelectionPage[];
			},
			comment: string,
		) => {
			const trimmed = comment.trim();
			if (!trimmed || !draft.pages.length) return;
			runAnnotationBatch(() => {
				const created = createHighlights(
					draft.pages,
					DEFAULT_HIGHLIGHT_COLOR,
					draft.quote,
					draft.visiblePages,
					draft.shape,
				);
				const first = created[0];
				if (!first) return;
				updateHighlightComment(first.pageIndex, first.id, trimmed);
			});
		},
		[createHighlights, updateHighlightComment, runAnnotationBatch],
	);

	return { handleCommitSelectionNote };
}
