import {
	commands,
	type InkApplyArgs,
	type InkReadArgs,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

export type {
	InkEdit,
	InkPage,
	InkPageSnapshot,
	InkPoint,
	InkStroke,
	InkStrokeDraft,
	InkTool,
} from "@/lib/core/bindings";

/** Read a validated, exact-byte snapshot; malformed sidecars are never empty pages. */
export function readPdfInk(args: InkReadArgs) {
	return callApiResult(() => commands.pdfReadInk(args));
}

/** Rust assigns revisions and checks the snapshot before publishing a page. */
export function applyPdfInk(args: InkApplyArgs) {
	return callApiResult(() => commands.pdfApplyInk(args));
}
