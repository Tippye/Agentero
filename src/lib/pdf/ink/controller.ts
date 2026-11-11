import type {
	InkEdit,
	InkPageSnapshot,
	InkStrokeDraft,
} from "@/lib/pdf/ink-api";
import type { InkShape } from "./geometry";

export type InkPageState = Readonly<{
	page: number;
	snapshot: InkPageSnapshot | null;
	strokes: readonly InkShape[];
	loading: boolean;
	saving: boolean;
	pending: readonly InkEdit[] | null;
	error: unknown | null;
	conflict: boolean;
}>;
export type InkOverview = Readonly<{
	dirty: boolean;
	saving: boolean;
	failedPage: number | null;
	conflict: boolean;
	canUndo: boolean;
	canRedo: boolean;
}>;
export type InkPersistence = {
	read(page: number): Promise<InkPageSnapshot>;
	apply(
		page: number,
		expectedRevision: string | null,
		operations: InkEdit[],
	): Promise<InkPageSnapshot>;
};
type History = { page: number; forward: InkEdit[]; inverse: InkEdit[] };
type Pending = {
	page: number;
	operations: InkEdit[];
	inverse: InkEdit[];
	kind: "edit" | "undo" | "redo";
	history?: History;
};

function finite(value: number | null): number {
	if (value === null || !Number.isFinite(value))
		throw new Error("Invalid native ink geometry");
	return value;
}
function draftShape(stroke: InkStrokeDraft): InkShape {
	return {
		id: stroke.id,
		tool: stroke.tool,
		color: [...stroke.color],
		baseWidth: finite(stroke.baseWidth),
		points: stroke.points.map((point) => ({
			...point,
			x: finite(point.x),
			y: finite(point.y),
			tilt: point.tilt ? [finite(point.tilt[0]), finite(point.tilt[1])] : null,
		})),
		createdAtMs: stroke.createdAtMs,
		updatedAtMs: stroke.updatedAtMs,
	};
}
/** Never roundtrip native Lamport counters/timestamps through mutable JS state. */
function shapes(snapshot: InkPageSnapshot): InkShape[] {
	return snapshot.document.strokes.map((stroke) =>
		draftShape({
			...stroke,
			createdAtMs: snapshot.creationTimes[stroke.id] ?? null,
			updatedAtMs: snapshot.updateTimes[stroke.id] ?? null,
		}),
	);
}
function preview(
	strokes: readonly InkShape[],
	operations: readonly InkEdit[],
): InkShape[] {
	const next = new Map(strokes.map((stroke) => [stroke.id, stroke]));
	for (const operation of operations) {
		if (operation.kind === "delete") next.delete(operation.id);
		else next.set(operation.stroke.id, draftShape(operation.stroke));
	}
	return [...next.values()];
}
function inverseEdits(
	strokes: readonly InkShape[],
	operations: readonly InkEdit[],
): InkEdit[] {
	const old = new Map(strokes.map((stroke) => [stroke.id, stroke]));
	return operations.map((operation): InkEdit => {
		const id = operation.kind === "put" ? operation.stroke.id : operation.id;
		const previous = old.get(id);
		return previous
			? { kind: "put", stroke: previous as InkStrokeDraft }
			: { kind: "delete", id };
	});
}
function acknowledgedEdits(
	operations: readonly InkEdit[],
	snapshot: InkPageSnapshot,
): InkEdit[] {
	const saved = new Map(shapes(snapshot).map((stroke) => [stroke.id, stroke]));
	return operations.map((operation) =>
		operation.kind === "put"
			? {
					kind: "put",
					stroke: saved.get(operation.stroke.id) ?? operation.stroke,
				}
			: operation,
	);
}
function editsAlreadyApplied(
	operations: readonly InkEdit[],
	snapshot: InkPageSnapshot,
): boolean {
	const saved = new Map(shapes(snapshot).map((stroke) => [stroke.id, stroke]));
	const content = (stroke: InkShape) =>
		JSON.stringify([
			stroke.id,
			stroke.tool,
			stroke.color,
			stroke.baseWidth,
			stroke.points,
		]);
	return operations.every((operation) =>
		operation.kind === "delete"
			? !saved.has(operation.id)
			: saved.has(operation.stroke.id) &&
				content(saved.get(operation.stroke.id) as InkShape) ===
					content(draftShape(operation.stroke)),
	);
}
function isConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ink_conflict"
	);
}

/** A document's edit queue. Every save/undo/redo is a native CAS patch, never a page overwrite. */
export class InkController {
	private pages = new Map<number, InkPageState>();
	private listeners = new Set<() => void>();
	private undoStack: History[] = [];
	private redoStack: History[] = [];
	private pending: Pending | null = null;
	private drawing = false;
	private overview: InkOverview = {
		dirty: false,
		saving: false,
		failedPage: null,
		conflict: false,
		canUndo: false,
		canRedo: false,
	};
	constructor(private persistence: InkPersistence) {}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	getOverview = () => this.overview;
	getPage = (page: number): InkPageState => {
		let state = this.pages.get(page);
		if (!state) {
			state = {
				page,
				snapshot: null,
				strokes: [],
				loading: false,
				saving: false,
				pending: null,
				error: null,
				conflict: false,
			};
			this.pages.set(page, state);
		}
		return state;
	};
	private publish(page?: number, patch?: Partial<InkPageState>) {
		if (page !== undefined && patch)
			this.pages.set(page, { ...this.getPage(page), ...patch });
		const states = [...this.pages.values()];
		const saving = states.some((state) => state.saving);
		const pendingState = this.pending
			? this.pages.get(this.pending.page)
			: null;
		const failed = pendingState?.error
			? pendingState
			: states.find((state) => state.error !== null);
		const busy = this.drawing || this.pending !== null || saving;
		this.overview = {
			dirty: busy,
			saving,
			failedPage: failed?.page ?? null,
			conflict: failed?.conflict ?? false,
			canUndo: !busy && this.undoStack.length > 0,
			canRedo: !busy && this.redoStack.length > 0,
		};
		for (const listener of this.listeners) listener();
	}
	setDrawing(drawing: boolean) {
		this.drawing = drawing;
		this.publish();
	}
	async load(page: number, refresh = false): Promise<void> {
		const state = this.getPage(page);
		if (
			state.loading ||
			state.saving ||
			state.pending ||
			(this.drawing && refresh) ||
			(state.snapshot && !refresh)
		)
			return;
		this.publish(page, { loading: true });
		try {
			const snapshot = await this.persistence.read(page);
			if (state.snapshot && state.snapshot.revision !== snapshot.revision) {
				// An external/sync change invalidates the old local undo branch.
				this.undoStack = this.undoStack.filter((entry) => entry.page !== page);
				this.redoStack = this.redoStack.filter((entry) => entry.page !== page);
			}
			this.publish(page, {
				snapshot,
				strokes: shapes(snapshot),
				loading: false,
				error: null,
				conflict: false,
			});
		} catch (error) {
			this.publish(page, { loading: false, error });
		}
	}
	edit(page: number, operations: InkEdit[]): boolean {
		const state = this.getPage(page);
		if (!operations.length || !state.snapshot || state.loading || this.pending)
			return false;
		this.pending = {
			page,
			operations,
			inverse: inverseEdits(state.strokes, operations),
			kind: "edit",
		};
		this.publish(page, {
			strokes: preview(state.strokes, operations),
			pending: operations,
		});
		void this.savePending();
		return true;
	}
	private async savePending() {
		const action = this.pending;
		if (!action) return;
		const state = this.getPage(action.page);
		if (state.saving || !state.snapshot) return;
		this.publish(action.page, { saving: true, error: null });
		try {
			for (const operation of action.operations) {
				if (operation.kind !== "put") continue;
				if (
					operation.stroke.points.some(
						(point) =>
							point.elapsedMs !== null &&
							(!Number.isSafeInteger(point.elapsedMs) ||
								point.elapsedMs < 0 ||
								point.elapsedMs > 4294967295),
					)
				)
					throw Object.assign(
						new Error("Ink sample time cannot be represented by a native edit"),
						{ code: "ink_invalid" },
					);
			}
			const snapshot = await this.persistence.apply(
				action.page,
				state.snapshot.revision,
				action.operations,
			);
			const acknowledged = acknowledgedEdits(action.operations, snapshot);
			if (action.kind === "edit") {
				this.undoStack.push({
					page: action.page,
					forward: acknowledged,
					inverse: action.inverse,
				});
				this.redoStack = [];
			} else if (action.kind === "undo" && action.history) {
				this.undoStack = this.undoStack.filter(
					(entry) => entry !== action.history,
				);
				this.redoStack.push({
					page: action.page,
					forward: action.inverse,
					inverse: acknowledged,
				});
			} else if (action.kind === "redo" && action.history) {
				this.redoStack = this.redoStack.filter(
					(entry) => entry !== action.history,
				);
				this.undoStack.push({
					page: action.page,
					forward: acknowledged,
					inverse: action.inverse,
				});
			}
			this.pending = null;
			this.publish(action.page, {
				snapshot,
				strokes: shapes(snapshot),
				saving: false,
				pending: null,
				error: null,
				conflict: false,
			});
		} catch (error) {
			const conflict = isConflict(error);
			// Retain UUIDs and the user's exact intended edit after any failure.
			// Refresh a conflicting baseline for review; retry is always explicit.
			try {
				const snapshot = await this.persistence.read(action.page);
				if (!editsAlreadyApplied(action.operations, snapshot))
					action.inverse = inverseEdits(shapes(snapshot), action.operations);
				if (snapshot.revision !== state.snapshot.revision) {
					this.undoStack = this.undoStack.filter(
						(entry) => entry.page !== action.page,
					);
					this.redoStack = this.redoStack.filter(
						(entry) => entry.page !== action.page,
					);
				}
				this.publish(action.page, {
					snapshot,
					strokes: preview(shapes(snapshot), action.operations),
				});
			} catch {
				/* Keep previous baseline if offline; outcome may be unknown. */
			}
			this.publish(action.page, { saving: false, error, conflict });
		}
	}
	async retry(): Promise<void> {
		if (this.pending) await this.savePending();
		else if (this.overview.failedPage !== null)
			await this.load(this.overview.failedPage, true);
	}
	discard(): void {
		const pending = this.pending;
		if (!pending || this.getPage(pending.page).saving) return;
		this.pending = null;
		const state = this.getPage(pending.page);
		this.publish(pending.page, {
			strokes: state.snapshot ? shapes(state.snapshot) : [],
			pending: null,
			error: null,
			conflict: false,
		});
		void this.load(pending.page, true);
	}
	undo(): void {
		this.history("undo");
	}
	redo(): void {
		this.history("redo");
	}
	private history(kind: "undo" | "redo") {
		if (this.pending || this.drawing) return;
		const entry = (kind === "undo" ? this.undoStack : this.redoStack).at(-1);
		if (!entry) return;
		const state = this.getPage(entry.page);
		const operations = kind === "undo" ? entry.inverse : entry.forward;
		this.pending = {
			page: entry.page,
			operations,
			inverse: inverseEdits(state.strokes, operations),
			kind,
			history: entry,
		};
		this.publish(entry.page, {
			strokes: preview(state.strokes, operations),
			pending: operations,
		});
		void this.savePending();
	}
	async exportPages(
		totalPages: number,
	): Promise<ReadonlyMap<number, readonly InkShape[]>> {
		if (this.overview.dirty) throw new Error("ink.unsaved");
		// Read a fresh native snapshot; never export a stale cached sync view.
		const output = new Map<number, readonly InkShape[]>();
		for (let page = 1; page <= totalPages; page++) {
			const snapshot = await this.persistence.read(page);
			output.set(page, shapes(snapshot));
		}
		return output;
	}
}
