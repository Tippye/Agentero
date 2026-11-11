import { describe, expect, it } from "vitest";
import {
	type InkShape,
	inkHitStroke,
	inkLassoIds,
	inkOutline,
	inkPointerSample,
	inkPointFromClient,
	moveInk,
} from "@/lib/pdf/ink/geometry";

const shape: InkShape = {
	id: "stroke",
	tool: "pen",
	color: [0, 0, 0, 255],
	baseWidth: 8,
	points: [
		{ x: 10, y: 10, pressure: 0.5, elapsedMs: 0, tilt: null },
		{ x: 90, y: 10, pressure: 0.5, elapsedMs: 10, tilt: null },
	],
};
describe("portable ink geometry", () => {
	it.each([
		0, 1, 2, 3,
	])("removes crop-relative page rotation %i and live CSS zoom from pointer coordinates", (rotation) => {
		const scale = 2.5,
			width = 100,
			height = 200;
		const positions = [
			[25, 60],
			[140, 25],
			[75, 140],
			[60, 75],
		];
		const [x, y] = positions[rotation];
		const box = {
			left: 37,
			top: 83,
			width: (rotation % 2 ? height : width) * scale,
			height: (rotation % 2 ? width : height) * scale,
		};
		expect(
			inkPointFromClient(
				{ x: box.left + x * scale, y: box.top + y * scale },
				box,
				{ width, height, rotation },
			),
		).toEqual({ x: 25, y: 60 });
	});
	it("keeps missing pressure distinct from zero and uses real pressure to change the mature outline", () => {
		const event = {
			pointerType: "pen",
			pressure: 0,
			tiltX: 0,
			tiltY: 0,
			timeStamp: 100,
		};
		expect(inkPointerSample(event, { x: 1, y: 2 }, 100).pressure).toBe(0);
		expect(
			inkPointerSample({ ...event, pointerType: "mouse" }, { x: 1, y: 2 }, 100)
				.pressure,
		).toBeNull();
		const span = (pressure: number) => {
			const ys = inkOutline({
				...shape,
				points: shape.points.map((p) => ({ ...p, pressure })),
			}).map((p) => p[1]);
			return Math.max(...ys) - Math.min(...ys);
		};
		expect(span(1)).toBeGreaterThan(span(0) * 1.4);
	});
	it("erases complete segments between sparse samples and selects entire lasso-enclosed strokes", () => {
		expect(inkHitStroke(shape, { x: 50, y: 10 }, 1)).toBe(true);
		expect(inkHitStroke(shape, { x: 50, y: 30 }, 1)).toBe(false);
		expect(inkHitStroke(shape, { x: 50, y: 40 }, 1, { x: 50, y: 0 })).toBe(
			true,
		);
		expect(
			inkLassoIds(
				[shape],
				[
					{ x: 0, y: 0 },
					{ x: 100, y: 0 },
					{ x: 100, y: 30 },
					{ x: 0, y: 30 },
				],
			),
		).toEqual([shape.id]);
		expect(
			inkLassoIds(
				[shape],
				[
					{ x: 20, y: 0 },
					{ x: 80, y: 0 },
					{ x: 80, y: 30 },
					{ x: 20, y: 30 },
				],
			),
		).toEqual([]);
	});
	it("moves a group without changing pressure/metadata and clamps it to the crop", () => {
		const [moved] = moveInk(
			[shape],
			{ x: 100, y: -100 },
			{ width: 100, height: 200 },
		);
		expect(moved.points[1].x).toBe(96);
		expect(moved.points[0].y).toBe(4);
		expect(moved.points[0].pressure).toBe(0.5);
		expect(shape.points[0]).toMatchObject({ x: 10, y: 10 });
	});
});
