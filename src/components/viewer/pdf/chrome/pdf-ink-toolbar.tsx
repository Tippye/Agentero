import {
	Copy,
	Download,
	Eraser,
	Hand,
	Highlighter,
	LassoSelect,
	Loader2,
	MessageCircleQuestion,
	PenLine,
	Redo2,
	RotateCcw,
	ScanSearch,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import { cn } from "@/lib/core/utils";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { INK_COLORS, type InkEditor, type InkMode } from "@/lib/pdf/ink/editor";
import { inkBoundsToRegion } from "@/lib/pdf/ink/geometry";

const TOOLS = [
	{ mode: "read", Icon: Hand },
	{ mode: "pen", Icon: PenLine },
	{ mode: "highlighter", Icon: Highlighter },
	{ mode: "eraser", Icon: Eraser },
	{ mode: "lasso", Icon: LassoSelect },
] as const;
const HIT = "size-11 min-h-11 min-w-11 shrink-0";

/** What the export menu asks the host to save. Ink is flattened on request. */
export type PdfInkExportOptions = {
	/** Document the copy is based on: the source PDF or its translation. */
	source: "original" | "translated";
	/** Flatten the handwritten strokes into the exported copy. */
	ink: boolean;
};

export function PdfInkToolbar({
	editor,
	editable,
	onExport,
	onAskRegion,
	cropPending = false,
	pageSize,
	regionSelecting = false,
	onToggleRegionSelect,
	canExportTranslated = false,
}: {
	editor: InkEditor;
	editable: boolean;
	onExport?: (options: PdfInkExportOptions) => Promise<void>;
	onAskRegion?: (page: number, region: PdfAskNormalizedRect) => Promise<void>;
	cropPending?: boolean;
	pageSize: (page: number) => { width: number; height: number } | null;
	/** Lasso marquee for a page region; it lives on this toolbar, not the top one. */
	regionSelecting?: boolean;
	onToggleRegionSelect?: () => void;
	/**
	 * The host can save a finished translated PDF as a copy. Off while the
	 * reflow is still building or when the platform has no save pipeline.
	 */
	canExportTranslated?: boolean;
}) {
	const { t } = useTranslation("viewer");
	const state = useSyncExternalStore(editor.subscribe, editor.getState);
	const overview = useSyncExternalStore(
		editor.controller.subscribe,
		editor.controller.getOverview,
	);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (state.paletteRequest > 0) setOpen(true);
	}, [state.paletteRequest]);
	const [exporting, setExporting] = useState(false);
	const [asking, setAsking] = useState(false);
	const askingRef = useRef(false);
	const busy = cropPending || asking;
	const selection = state.selection;
	const size = selection ? pageSize(selection.page) : null;
	const region =
		selection && size
			? inkBoundsToRegion(editor.getSelectionBounds(), size)
			: null;
	const baseline = selection ? editor.controller.getPage(selection.page) : null;
	const canAsk =
		!!region &&
		!!baseline?.snapshot &&
		!baseline.loading &&
		!baseline.error &&
		!overview.dirty;
	const active = TOOLS.find((tool) => tool.mode === state.mode) ?? TOOLS[0];
	const select = (mode: InkMode) => {
		if (busy) return;
		editor.setMode(mode);
		setOpen(false);
	};
	const runExport = (options: PdfInkExportOptions) => {
		if (!onExport || exporting || busy || overview.dirty) return;
		setExporting(true);
		void onExport(options).finally(() => setExporting(false));
	};
	if (!editable && !onExport && !onToggleRegionSelect) return null;
	return (
		<div
			data-pdf-chrome
			className="pointer-events-none absolute right-2 bottom-14 left-2 z-30 flex justify-center"
		>
			<div
				role="toolbar"
				aria-label={t("ink.tools")}
				className={cn(
					"pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl p-1",
					PDF_CHROME_CHIP,
				)}
			>
				{editable && (
					<>
						<Popover open={open} onOpenChange={setOpen}>
							<PopoverTrigger asChild>
								<Button
									className={HIT}
									disabled={busy}
									variant={state.mode === "read" ? "ghost" : "secondary"}
									size="icon"
									aria-label={t("ink.tools")}
									title={t(`ink.${state.mode}`)}
								>
									<active.Icon className="size-5" />
								</Button>
							</PopoverTrigger>
							<PopoverContent
								side="top"
								align="start"
								className="w-auto max-w-[calc(100vw-2rem)] p-1"
							>
								<div
									role="toolbar"
									aria-label={t("ink.tools")}
									className="flex flex-wrap"
								>
									{TOOLS.map(({ mode, Icon }) => (
										<Button
											key={mode}
											className={HIT}
											variant={state.mode === mode ? "secondary" : "ghost"}
											size="icon"
											aria-label={t(`ink.${mode}`)}
											title={t(`ink.${mode}`)}
											aria-pressed={state.mode === mode}
											onClick={() => select(mode)}
										>
											<Icon className="size-5" />
										</Button>
									))}
								</div>
								<fieldset
									className="m-0 flex flex-wrap border-0 p-0"
									aria-label={t("ink.color")}
								>
									{INK_COLORS.map((color) => (
										<Button
											key={color}
											className={HIT}
											variant={state.color === color ? "secondary" : "ghost"}
											size="icon"
											aria-label={`${t("ink.color")} ${color}`}
											aria-pressed={state.color === color}
											onClick={() => editor.setColor(color)}
										>
											<span
												className="size-5 rounded-full border border-black/30"
												style={{ backgroundColor: color }}
											/>
										</Button>
									))}
								</fieldset>
								<label className="flex min-h-11 items-center gap-3 px-3 text-sm">
									<span>{t("ink.width")}</span>
									<input
										type="range"
										className="h-11 min-w-0 flex-1"
										min={1}
										max={8}
										step={0.5}
										value={state.width}
										onChange={(event) =>
											editor.setWidth(Number(event.target.value))
										}
										aria-label={t("ink.width")}
									/>
									<span className="w-7 text-right tabular-nums">
										{state.width}
									</span>
								</label>
							</PopoverContent>
						</Popover>
						<Button
							className={HIT}
							size="icon"
							variant="ghost"
							disabled={busy || !overview.canUndo}
							aria-label={t("ink.undo")}
							title={t("ink.undo")}
							onClick={() => editor.controller.undo()}
						>
							<Undo2 className="size-5" />
						</Button>
						<Button
							className={HIT}
							size="icon"
							variant="ghost"
							disabled={busy || !overview.canRedo}
							aria-label={t("ink.redo")}
							title={t("ink.redo")}
							onClick={() => editor.controller.redo()}
						>
							<Redo2 className="size-5" />
						</Button>
						{state.selection && state.selection.ids.length > 0 && (
							<>
								<Button
									className={HIT}
									size="icon"
									variant="ghost"
									disabled={busy || overview.dirty}
									aria-label={t("ink.copy")}
									title={t("ink.copy")}
									onClick={() => {
										const size = pageSize(state.selection?.page ?? 1);
										if (size) editor.copySelection(size);
									}}
								>
									<Copy className="size-5" />
								</Button>
								<Button
									className={HIT}
									size="icon"
									variant="ghost"
									disabled={busy || overview.dirty}
									aria-label={t("ink.delete")}
									title={t("ink.delete")}
									onClick={() => editor.deleteSelection()}
								>
									<Trash2 className="size-5" />
								</Button>
							</>
						)}
					</>
				)}
				{onToggleRegionSelect && (
					<Button
						className={HIT}
						size="icon"
						variant={regionSelecting ? "secondary" : "ghost"}
						disabled={busy || exporting}
						aria-label={t("ink.regionSelect")}
						title={t("ink.regionSelect")}
						aria-pressed={regionSelecting}
						onClick={onToggleRegionSelect}
					>
						<ScanSearch className="size-5" />
					</Button>
				)}
				{editable && onAskRegion && (canAsk || asking) && (
					<Button
						className={HIT}
						size="icon"
						variant="ghost"
						disabled={busy || exporting}
						aria-busy={asking}
						aria-label={t("ink.askRegion")}
						title={t("ink.askRegion")}
						onClick={() => {
							if (
								askingRef.current ||
								cropPending ||
								editor.controller.getOverview().dirty
							)
								return;
							const current = editor.getState().selection;
							const currentSize = current ? pageSize(current.page) : null;
							const target = currentSize
								? inkBoundsToRegion(editor.getSelectionBounds(), currentSize)
								: null;
							const loaded = current
								? editor.controller.getPage(current.page)
								: null;
							if (
								!current ||
								!target ||
								!loaded?.snapshot ||
								loaded.loading ||
								loaded.error
							)
								return;
							const page = current.page,
								captured = { ...target };
							askingRef.current = true;
							setAsking(true);
							editor.setMode("read");
							void onAskRegion(page, captured).finally(() => {
								askingRef.current = false;
								setAsking(false);
							});
						}}
					>
						{asking ? (
							<Loader2 className="size-5 animate-spin" />
						) : (
							<MessageCircleQuestion className="size-5" />
						)}
					</Button>
				)}
				{overview.failedPage !== null && (
					<>
						<Button
							className={HIT}
							size="icon"
							variant="ghost"
							disabled={overview.saving}
							aria-label={t("ink.retry")}
							title={t(overview.conflict ? "ink.conflict" : "ink.retry")}
							onClick={() => {
								void editor.controller.retry();
							}}
						>
							<RotateCcw className="size-5 text-destructive" />
						</Button>
						{overview.dirty && (
							<Button
								className={HIT}
								size="icon"
								variant="ghost"
								disabled={overview.saving}
								aria-label={t("ink.discard")}
								title={t("ink.discard")}
								onClick={() => editor.controller.discard()}
							>
								<X className="size-5" />
							</Button>
						)}
					</>
				)}
				{onExport && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								className={HIT}
								size="icon"
								variant="ghost"
								disabled={busy || overview.dirty || exporting}
								aria-label={t("ink.export")}
								title={t("ink.export")}
								aria-busy={exporting}
							>
								{exporting ? (
									<Loader2 className="size-5 animate-spin" />
								) : (
									<Download className="size-5" />
								)}
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							side="top"
							align="end"
							className="w-auto max-w-[min(18rem,calc(100vw-2rem))]"
						>
							<DropdownMenuItem
								className="min-h-11"
								disabled={busy || exporting}
								onSelect={() => runExport({ source: "original", ink: false })}
							>
								{t("ink.exportOriginalNoInk")}
							</DropdownMenuItem>
							<DropdownMenuItem
								className="min-h-11"
								disabled={busy || exporting}
								onSelect={() => runExport({ source: "original", ink: true })}
							>
								{t("ink.exportOriginalInk")}
							</DropdownMenuItem>
							<DropdownMenuItem
								className="min-h-11"
								disabled={busy || exporting || !canExportTranslated}
								onSelect={() => runExport({ source: "translated", ink: false })}
							>
								{t("ink.exportTranslatedNoInk")}
							</DropdownMenuItem>
							{/* No pipeline flattens strokes onto the translated reflow
							    yet, so this combination stays unavailable. */}
							<DropdownMenuItem className="min-h-11" disabled>
								{t("ink.exportTranslatedInk")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				{overview.saving && (
					<Loader2
						className="mx-2 size-5 shrink-0 animate-spin"
						aria-label={t("ink.unsaved")}
					/>
				)}
			</div>
		</div>
	);
}
