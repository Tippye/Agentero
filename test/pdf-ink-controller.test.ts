import { describe, expect, it, vi } from "vitest";
import { InkController } from "@/lib/pdf/ink/controller";
import { InkEditor } from "@/lib/pdf/ink/editor";
import type { InkShape } from "@/lib/pdf/ink/geometry";
import type { InkEdit, InkPageSnapshot } from "@/lib/pdf/ink-api";

const stroke = (id = "00000000-0000-4000-8000-000000000001"): InkShape => ({
	id,
	tool: "pen",
	color: [0, 0, 0, 255],
	baseWidth: 2,
	points: [
		{ x: 10, y: 10, pressure: 0, elapsedMs: 0, tilt: null },
		{ x: 20, y: 20, pressure: 1, elapsedMs: 10, tilt: [0, 0] },
	],
});
function native(varyCreation = false) {
	let revision = 0;
	const creationValues = new Map<string, string>();
	const strokes = new Map<string, InkShape>();
	const tombstones = new Map<string, number>();
	const created = "9007199254740999",
		updated = "9007199254741001";
	const snapshot = (): InkPageSnapshot => ({
		document: {
			version: 1,
			page: 1,
			strokes: [...strokes.values()].map((s) => ({
				...s,
				page: 1,
				revision: { counter: revision, actor: "native-actor" },
				createdAtMs: Number(created),
				updatedAtMs: Number(updated),
			})),
			tombstones: [...tombstones].map(([id, counter]) => ({
				id,
				revision: { counter, actor: "native-actor" },
				deletedAtMs: Number(updated),
			})),
		},
		revision: revision ? `revision-${revision}` : null,
		creationTimes: Object.fromEntries(
			[...strokes.keys()].map((id) => [id, creationValues.get(id) ?? created]),
		),
		updateTimes: Object.fromEntries(
			[...strokes.keys()].map((id) => [id, updated]),
		),
	});
	const read = vi.fn(async () => snapshot());
	const apply = vi.fn(
		async (_page: number, baseline: string | null, operations: InkEdit[]) => {
			if (baseline !== snapshot().revision)
				throw Object.assign(new Error("newer sync data"), {
					code: "ink_conflict",
				});
			revision++;
			for (const op of operations) {
				if (op.kind === "delete") {
					strokes.delete(op.id);
					creationValues.delete(op.id);
					tombstones.set(op.id, revision);
				} else {
					if (!strokes.has(op.stroke.id))
						creationValues.set(
							op.stroke.id,
							op.stroke.createdAtMs ??
								(varyCreation
									? (BigInt(created) + BigInt(revision)).toString()
									: created),
						);
					strokes.set(op.stroke.id, op.stroke);
					tombstones.delete(op.stroke.id);
				}
			}
			return snapshot();
		},
	);
	return {
		read,
		apply,
		snapshot,
		putExternal(s: InkShape) {
			strokes.set(s.id, s);
			revision++;
		},
	};
}
const settled = async (controller: InkController) =>
	vi.waitFor(() => expect(controller.getOverview().saving).toBe(false));

describe("native revision-checked ink edits", () => {
	it("eraser deletion creates a native tombstone and undo/redo uses new revisions and opaque creation/update metadata", async () => {
		const api = native(),
			controller = new InkController(api);
		await controller.load(1);
		controller.edit(1, [{ kind: "put", stroke: stroke() }]);
		await settled(controller);
		controller.edit(1, [{ kind: "delete", id: stroke().id }]);
		await settled(controller);
		expect(api.snapshot().document.strokes).toHaveLength(0);
		expect(api.snapshot().document.tombstones).toHaveLength(1);
		controller.undo();
		await settled(controller);
		expect(api.snapshot().revision).toBe("revision-3");
		expect(api.snapshot().document.strokes).toHaveLength(1);
		expect(api.apply.mock.calls.at(-1)?.[2]).toEqual([
			{
				kind: "put",
				stroke: {
					...stroke(),
					createdAtMs: "9007199254740999",
					updatedAtMs: "9007199254741001",
				},
			},
		]);
		controller.redo();
		await settled(controller);
		expect(api.snapshot().revision).toBe("revision-4");
		expect(api.snapshot().document.tombstones).toHaveLength(1);
		controller.undo();
		await settled(controller);
		controller.undo();
		await settled(controller);
		expect(api.snapshot().document.strokes).toHaveLength(0);
		expect(api.snapshot().revision).toBe("revision-6");
	});

	it("retains a failed save with the same UUID until explicit retry and never duplicates an unknown accepted write", async () => {
		const api = native(),
			controller = new InkController(api);
		await controller.load(1);
		const realApply = api.apply.getMockImplementation();
		api.apply.mockImplementationOnce(async (...args) => {
			await realApply?.(...args);
			throw Object.assign(new Error("fsync outcome uncertain"), {
				code: "ink_unavailable",
			});
		});
		controller.edit(1, [{ kind: "put", stroke: stroke() }]);
		await settled(controller);
		expect(controller.getOverview().dirty).toBe(true);
		expect(controller.getPage(1).pending?.[0]).toMatchObject({
			kind: "put",
			stroke: { id: stroke().id },
		});
		expect(api.apply).toHaveBeenCalledTimes(1);
		expect(controller.getPage(1).snapshot?.revision).toBe("revision-1");
		await controller.retry();
		expect(controller.getOverview().dirty).toBe(false);
		expect(api.snapshot().document.strokes.map((s) => s.id)).toEqual([
			stroke().id,
		]);
		expect(api.apply.mock.calls[1][1]).toBe("revision-1");
	});

	it("preserves newer sync strokes on CAS conflict, retains the proposed edit, and does not automatically retry", async () => {
		const api = native(),
			controller = new InkController(api);
		await controller.load(1);
		const remote = stroke("00000000-0000-4000-8000-000000000002");
		api.putExternal(remote);
		controller.edit(1, [{ kind: "put", stroke: stroke() }]);
		await settled(controller);
		expect(controller.getOverview()).toMatchObject({
			dirty: true,
			conflict: true,
			canUndo: false,
		});
		expect(controller.getPage(1).strokes.map((s) => s.id)).toEqual([
			remote.id,
			stroke().id,
		]);
		expect(api.apply).toHaveBeenCalledTimes(1);
		await controller.retry();
		expect(api.snapshot().document.strokes).toHaveLength(2);
		expect(api.apply.mock.calls[1][2]).toHaveLength(1);
	});

	it("discards cancelled eraser/pen drafts and keeps lasso move-copy-delete as per-stroke edits", async () => {
		const api = native();
		api.putExternal(stroke());
		const controller = new InkController(api),
			editor = new InkEditor(controller);
		await controller.load(1);
		const page = {
			page: 1,
			width: 100,
			height: 100,
			rotation: 0,
			element: {} as HTMLElement,
		};
		const sample = { x: 15, y: 15, pressure: 0.5, elapsedMs: 0, tilt: null };
		editor.setMode("eraser");
		editor.begin(page, sample);
		editor.cancel();
		expect(api.apply).not.toHaveBeenCalled();
		expect(controller.getOverview().dirty).toBe(false);
		editor.setMode("lasso");
		editor.begin(page, { ...sample, x: 0, y: 0 });
		editor.append([
			{ ...sample, x: 30, y: 0 },
			{ ...sample, x: 30, y: 30 },
			{ ...sample, x: 0, y: 30 },
		]);
		editor.finish();
		expect(editor.getState().selection?.ids).toEqual([stroke().id]);
		editor.begin(page, sample);
		editor.append([{ ...sample, x: 25, y: 30 }]);
		editor.finish();
		await settled(controller);
		expect(controller.getPage(1).strokes[0].points[0]).toMatchObject({
			x: 20,
			y: 25,
		});
		editor.copySelection(page);
		await settled(controller);
		expect(api.snapshot().document.strokes).toHaveLength(2);
		expect(new Set(api.snapshot().document.strokes.map((s) => s.id)).size).toBe(
			2,
		);
		editor.deleteSelection();
		await settled(controller);
		expect(api.snapshot().document.strokes).toHaveLength(1);
	});

	it("keeps the acknowledged native creation time across new-stroke undo and redo", async () => {
		const api = native(true),
			controller = new InkController(api);
		await controller.load(1);
		controller.edit(1, [{ kind: "put", stroke: stroke() }]);
		await settled(controller);
		const created = api.snapshot().creationTimes[stroke().id];
		controller.undo();
		await settled(controller);
		controller.redo();
		await settled(controller);
		expect(api.snapshot().creationTimes[stroke().id]).toBe(created);
	});

	it("rebases undo to the reviewed same-ID sync change after an explicit conflict retry", async () => {
		const api = native(),
			initial = stroke();
		api.putExternal(initial);
		const controller = new InkController(api);
		await controller.load(1);
		const remote = {
			...initial,
			points: initial.points.map((point) => ({ ...point, x: point.x + 50 })),
		};
		api.putExternal(remote);
		const proposal = {
			...initial,
			points: initial.points.map((point) => ({ ...point, x: point.x + 10 })),
		};
		controller.edit(1, [{ kind: "put", stroke: proposal }]);
		await settled(controller);
		expect(controller.getOverview().conflict).toBe(true);
		await controller.retry();
		controller.undo();
		await settled(controller);
		expect(api.snapshot().document.strokes[0].points).toEqual(remote.points);
	});

	it("refuses to round unsupported legacy elapsed times into new native edits", async () => {
		const api = native(),
			controller = new InkController(api);
		await controller.load(1);
		const legacy = stroke();
		legacy.points[0].elapsedMs = 4294967296;
		controller.edit(1, [{ kind: "put", stroke: legacy }]);
		await settled(controller);
		expect(api.apply).not.toHaveBeenCalled();
		expect(controller.getOverview().dirty).toBe(true);
		controller.discard();
		expect(controller.getOverview().dirty).toBe(false);
	});
});
