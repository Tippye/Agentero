import type { InkEdit } from "@/lib/pdf/ink-api";
import type { InkController } from "./controller";
import {
	type InkBounds,
	type InkPosition,
	type InkSample,
	type InkShape,
	inkBounds,
	inkHitStroke,
	inkLassoBounds,
	inkLassoIds,
	moveInk,
} from "./geometry";

export type InkMode = "read" | "pen" | "highlighter" | "eraser" | "lasso";
export type InkEditorState = Readonly<{
	mode: InkMode;
	color: string;
	width: number;
	selection: { page: number; ids: string[]; bounds: InkBounds | null } | null;
	draft: { page: number; stroke: InkShape } | null;
	lasso: { page: number; points: InkPosition[] } | null;
	moving: { page: number; strokes: InkShape[] } | null;
	erasing: { page: number; ids: string[] } | null;
}>;
export type InkInputPage = {
	page: number;
	width: number;
	height: number;
	rotation: number;
	element: HTMLElement;
};
type Gesture = {
	page: InkInputPage;
	tool: Exclude<InkMode, "read">;
	origin: InkPosition;
	samples: InkSample[];
	stroke?: InkShape;
	originals?: InkShape[];
};
export const INK_COLORS = [
	"#202124",
	"#c92a2a",
	"#1864ab",
	"#2b8a3e",
	"#f0b429",
] as const;

/** Tool state is independent of native revisions and the PDF annotation plugin. */
export class InkEditor {
	private state: InkEditorState = {
		mode: "read",
		color: INK_COLORS[0],
		width: 2,
		selection: null,
		draft: null,
		lasso: null,
		moving: null,
		erasing: null,
	};
	private listeners = new Set<() => void>();
	private gesture: Gesture | null = null;
	constructor(readonly controller: InkController) {}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	getState = () => this.state;
	getSelectionBounds = (): InkBounds | null => {
		const selection = this.state.selection;
		if (!selection) return null;
		return (
			selection.bounds ??
			inkBounds(
				this.controller
					.getPage(selection.page)
					.strokes.filter((stroke) => selection.ids.includes(stroke.id)),
			)
		);
	};
	private update(patch: Partial<InkEditorState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	setMode(mode: InkMode) {
		this.cancel();
		this.update({ mode, selection: null });
	}
	setColor(color: string) {
		this.update({ color });
	}
	setWidth(width: number) {
		this.update({ width });
	}
	begin(page: InkInputPage, sample: InkSample, eraser = false): boolean {
		const mode = eraser ? "eraser" : this.state.mode;
		const state = this.controller.getPage(page.page);
		if (
			mode === "read" ||
			!state.snapshot ||
			state.loading ||
			this.controller.getOverview().dirty ||
			this.gesture
		)
			return false;
		const gesture: Gesture = {
			page,
			tool: mode,
			origin: sample,
			samples: [sample],
		};
		this.gesture = gesture;
		this.controller.setDrawing(true);
		if (mode === "pen" || mode === "highlighter") {
			const hex = this.state.color.slice(1);
			gesture.stroke = {
				id: crypto.randomUUID(),
				tool: mode,
				color: [
					parseInt(hex.slice(0, 2), 16),
					parseInt(hex.slice(2, 4), 16),
					parseInt(hex.slice(4, 6), 16),
					mode === "highlighter" ? 85 : 255,
				],
				baseWidth:
					mode === "highlighter" ? this.state.width * 6 : this.state.width,
				points: [sample],
			};
			this.update({
				draft: { page: page.page, stroke: gesture.stroke },
				selection: null,
			});
		} else if (mode === "lasso") {
			const selected =
				this.state.selection?.page === page.page
					? state.strokes.filter((stroke) =>
							this.state.selection?.ids.includes(stroke.id),
						)
					: [];
			const bounds = inkBounds(selected);
			if (
				bounds &&
				sample.x >= bounds.x &&
				sample.x <= bounds.x + bounds.width &&
				sample.y >= bounds.y &&
				sample.y <= bounds.y + bounds.height
			)
				gesture.originals = selected;
			else
				this.update({
					selection: null,
					lasso: { page: page.page, points: [sample] },
				});
		} else
			this.update({
				erasing: { page: page.page, ids: this.eraseAt(page.page, sample, []) },
				selection: null,
			});
		return true;
	}
	private eraseAt(
		page: number,
		point: InkPosition,
		ids: string[],
		previous: InkPosition = point,
	): string[] {
		return [
			...new Set([
				...ids,
				...this.controller
					.getPage(page)
					.strokes.filter((stroke) => inkHitStroke(stroke, point, 8, previous))
					.map((stroke) => stroke.id),
			]),
		];
	}
	append(samples: InkSample[]) {
		const gesture = this.gesture;
		if (!gesture || !samples.length) return;
		let previous = gesture.samples.at(-1) ?? gesture.origin;
		gesture.samples.push(...samples);
		if (gesture.stroke) {
			gesture.stroke = { ...gesture.stroke, points: gesture.samples.slice() };
			this.update({
				draft: { page: gesture.page.page, stroke: gesture.stroke },
			});
		} else if (gesture.tool === "eraser") {
			let ids = this.state.erasing?.ids ?? [];
			for (const point of samples) {
				ids = this.eraseAt(gesture.page.page, point, ids, previous);
				previous = point;
			}
			this.update({ erasing: { page: gesture.page.page, ids } });
		} else if (gesture.originals) {
			const last = samples.at(-1) as InkSample;
			this.update({
				moving: {
					page: gesture.page.page,
					strokes: moveInk(
						gesture.originals,
						{ x: last.x - gesture.origin.x, y: last.y - gesture.origin.y },
						gesture.page,
					),
				},
			});
		} else
			this.update({
				lasso: { page: gesture.page.page, points: gesture.samples },
			});
	}
	finish() {
		const gesture = this.gesture;
		if (!gesture) return;
		let operations: InkEdit[] = [];
		if (gesture.stroke) operations = [{ kind: "put", stroke: gesture.stroke }];
		else if (gesture.tool === "eraser")
			operations = (this.state.erasing?.ids ?? []).map((id) => ({
				kind: "delete",
				id,
			}));
		else if (gesture.originals) {
			const moved = this.state.moving?.strokes ?? [];
			operations = moved.map((stroke) => ({ kind: "put", stroke }));
			if (moved.length)
				this.update({
					selection: {
						page: gesture.page.page,
						ids: moved.map((stroke) => stroke.id),
						// Transformed ink follows current native geometry, including undo/sync.
						bounds: null,
					},
				});
		} else
			this.update({
				selection: {
					page: gesture.page.page,
					bounds: inkLassoBounds(gesture.samples),
					ids: inkLassoIds(
						this.controller.getPage(gesture.page.page).strokes,
						gesture.samples,
					),
				},
			});
		this.gesture = null;
		// Move directly from transient geometry to pending native edits; parent
		// navigation guards must never observe a clean gap at pointerup.
		if (operations.length) this.controller.edit(gesture.page.page, operations);
		this.controller.setDrawing(false);
		this.update({ draft: null, lasso: null, moving: null, erasing: null });
	}
	cancel() {
		if (!this.gesture) return;
		this.gesture = null;
		this.controller.setDrawing(false);
		this.update({ draft: null, lasso: null, moving: null, erasing: null });
	}
	deleteSelection() {
		const selection = this.state.selection;
		if (!selection) return;
		if (
			this.controller.edit(
				selection.page,
				selection.ids.map((id) => ({ kind: "delete", id })),
			)
		)
			this.update({ selection: null });
	}
	copySelection(pageSize: { width: number; height: number }) {
		const selection = this.state.selection;
		if (!selection) return;
		const strokes = this.controller
			.getPage(selection.page)
			.strokes.filter((stroke) => selection.ids.includes(stroke.id));
		const copies = moveInk(strokes, { x: 12, y: 12 }, pageSize).map(
			(stroke) => ({
				...stroke,
				id: crypto.randomUUID(),
				createdAtMs: null,
				updatedAtMs: null,
			}),
		);
		if (
			this.controller.edit(
				selection.page,
				copies.map((stroke) => ({ kind: "put", stroke })),
			)
		)
			this.update({
				selection: {
					page: selection.page,
					ids: copies.map((stroke) => stroke.id),
					bounds: null,
				},
			});
	}
}
