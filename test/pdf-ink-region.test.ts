import { describe, expect, it, vi } from "vitest";
import { InkController } from "@/lib/pdf/ink/controller";
import { InkEditor } from "@/lib/pdf/ink/editor";
import {
	type InkShape,
	inkBoundsToRegion,
	inkLassoBounds,
} from "@/lib/pdf/ink/geometry";
import type { InkEdit } from "@/lib/pdf/ink-api";

const sample = (x: number, y: number) => ({
	x,
	y,
	pressure: null,
	tilt: null,
	elapsedMs: null,
});
const page = {
	page: 1,
	width: 200,
	height: 300,
	rotation: 0,
	element: {} as HTMLElement,
};
async function editorWithStroke() {
	const original: InkShape = {
		id: "00000000-0000-4000-8000-000000000001",
		tool: "pen",
		color: [0, 0, 0, 255],
		baseWidth: 2,
		points: [sample(20, 30), sample(40, 40)],
	};
	const rows = new Map([[original.id, original]]);
	let revision = 0;
	const snapshot = () => ({
		revision: String(revision),
		creationTimes: {},
		updateTimes: {},
		document: {
			version: 1,
			page: 1,
			tombstones: [],
			strokes: [...rows.values()].map((stroke) => ({
				...stroke,
				page: 1,
				revision: { actor: original.id, counter: revision },
				createdAtMs: 1,
				updatedAtMs: 1,
			})),
		},
	});
	const apply = vi.fn(
		async (_page: number, _revision: string | null, operations: InkEdit[]) => {
			for (const operation of operations) {
				if (operation.kind === "delete") rows.delete(operation.id);
				else rows.set(operation.stroke.id, operation.stroke as InkShape);
			}
			revision++;
			return snapshot();
		},
	);
	const controller = new InkController({ read: async () => snapshot(), apply });
	await controller.load(1);
	const editor = new InkEditor(controller);
	editor.setMode("lasso");
	editor.begin(page, sample(0, 0));
	editor.append([sample(100, 0), sample(100, 100), sample(0, 100)]);
	editor.finish();
	return { editor, controller, apply, original };
}
describe("lasso prompt bounds", () => {
	it("rejects taps, collinear paths, non-finite samples and tiny regions", () => {
		expect(inkLassoBounds([sample(0, 0)])).toBeNull();
		expect(
			inkLassoBounds([sample(0, 0), sample(50, 50), sample(100, 100)]),
		).toBeNull();
		expect(
			inkLassoBounds([sample(0, 0), sample(1, 0), sample(1, 1), sample(0, 1)]),
		).toBeNull();
		expect(
			inkLassoBounds([sample(0, 0), sample(50, 0), sample(NaN, 50)]),
		).toBeNull();
	});
	it("clips selected bounds into the unrotated visible crop and refuses invalid page sizes", () => {
		expect(
			inkBoundsToRegion({ x: -20, y: 30, width: 100, height: 300 }, page),
		).toEqual({ x: 0, y: 0.1, w: 0.4, h: 0.9 });
		expect(
			inkBoundsToRegion(
				{ x: 20, y: 30, width: 10, height: 10 },
				{ width: 0, height: 10 },
			),
		).toBeNull();
	});
	it("recomputes bounds from moved/copied ink instead of reusing the original lasso region", async () => {
		const { editor, controller, original } = await editorWithStroke();
		expect(editor.getState().selection?.bounds).toEqual({
			x: 0,
			y: 0,
			width: 100,
			height: 100,
		});
		editor.begin(page, sample(30, 35));
		editor.append([sample(70, 60)]);
		editor.finish();
		await vi.waitFor(() => expect(controller.getOverview().dirty).toBe(false));
		expect(editor.getSelectionBounds()).toEqual({
			x: 59,
			y: 54,
			width: 22,
			height: 12,
		});
		editor.copySelection(page);
		await vi.waitFor(() => expect(controller.getOverview().dirty).toBe(false));
		expect(editor.getSelectionBounds()).toEqual({
			x: 71,
			y: 66,
			width: 22,
			height: 12,
		});
		expect(editor.getState().selection?.ids).not.toContain(original.id);
		expect(controller.getPage(1).strokes).toHaveLength(2);
		controller.undo();
		await vi.waitFor(() => expect(controller.getOverview().dirty).toBe(false));
		expect(editor.getSelectionBounds()).toBeNull();
		controller.redo();
		await vi.waitFor(() => expect(controller.getOverview().dirty).toBe(false));
		expect(editor.getSelectionBounds()).toEqual({
			x: 71,
			y: 66,
			width: 22,
			height: 12,
		});
		editor.deleteSelection();
		await vi.waitFor(() => expect(controller.getOverview().dirty).toBe(false));
		expect(editor.getState().selection).toBeNull();
		expect(controller.getPage(1).strokes).toHaveLength(1);
	});
	it("keeps the previous valid region after cancelling a move without writing any geometry", async () => {
		const { editor, controller, apply, original } = await editorWithStroke();
		editor.begin(page, sample(30, 35));
		editor.append([sample(70, 60)]);
		editor.cancel();
		expect(editor.getState().selection?.bounds).toEqual({
			x: 0,
			y: 0,
			width: 100,
			height: 100,
		});
		expect(controller.getPage(1).strokes[0].points).toEqual(original.points);
		expect(apply).not.toHaveBeenCalled();
	});
});
