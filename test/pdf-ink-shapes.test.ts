import { describe, expect, it } from "vitest";
import type { InkPosition } from "@/lib/pdf/ink/geometry";
import { recognizeInkShape } from "@/lib/pdf/ink/shapes";

const dist = (a: InkPosition, b: InkPosition) =>
	Math.hypot(b.x - a.x, b.y - a.y);

/** Wobble a polyline deterministically, keeping its endpoints exact. */
function wobble(
	vertices: InkPosition[],
	perEdge: number,
	amplitude: number,
	closed: boolean,
): InkPosition[] {
	const out: InkPosition[] = [];
	const edges = closed ? vertices.length : vertices.length - 1;
	for (let e = 0; e < edges; e++) {
		const a = vertices[e],
			b = vertices[(e + 1) % vertices.length];
		const len = dist(a, b),
			nx = -(b.y - a.y) / len,
			ny = (b.x - a.x) / len;
		for (let i = 0; i < perEdge; i++) {
			const t = i / perEdge;
			const offset = i === 0 ? 0 : amplitude * Math.sin(i * 2.3 + e * 1.7);
			out.push({
				x: a.x + (b.x - a.x) * t + nx * offset,
				y: a.y + (b.y - a.y) * t + ny * offset,
			});
		}
	}
	out.push({ ...vertices[closed ? 0 : vertices.length - 1] });
	return out;
}

function sharpCorners(points: InkPosition[]): number[] {
	const closed = dist(points[0], points[points.length - 1]) < 1e-6;
	const count = closed ? points.length - 1 : points.length;
	const angles: number[] = [];
	for (let i = closed ? 0 : 1; i < (closed ? count : count - 1); i++) {
		const a = points[(i - 1 + count) % count],
			b = points[i],
			c = points[(i + 1) % count];
		const ax = a.x - b.x,
			ay = a.y - b.y,
			cx = c.x - b.x,
			cy = c.y - b.y;
		const cos = (ax * cx + ay * cy) / (Math.hypot(ax, ay) * Math.hypot(cx, cy));
		const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
		if (angle < 135) angles.push(angle);
	}
	return angles;
}

function expectShape(points: InkPosition[]): InkPosition[] {
	const shape = recognizeInkShape(points);
	expect(shape).not.toBeNull();
	if (!shape) throw new Error("expected a recognized shape");
	return shape;
}

describe("hold-to-shape recognition", () => {
	it("straightens a wobbly line to its exact endpoints", () => {
		const points: InkPosition[] = [];
		for (let i = 0; i <= 50; i++)
			points.push({ x: i * 4, y: 50 + 2 * Math.sin(i * 1.7) });
		const shape = expectShape(points);
		expect(shape).toHaveLength(2);
		expect(shape[0]).toEqual(points[0]);
		expect(shape[1]).toEqual(points[50]);
	});

	it("snaps a wobbly closed circle to a perfect circle", () => {
		const points: InkPosition[] = [];
		for (let i = 0; i <= 72; i++) {
			const t = (2 * Math.PI * i) / 72;
			const r = 50 + 1.5 * Math.sin(5 * t);
			points.push({ x: 100 + r * Math.cos(t), y: 100 + r * Math.sin(t) });
		}
		const shape = expectShape(points);
		expect(shape.length).toBe(49);
		expect(dist(shape[0], shape[shape.length - 1])).toBeLessThan(1e-6);
		const radii = shape.map((p) => dist(p, { x: 100, y: 100 }));
		const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
		expect(mean).toBeGreaterThan(48);
		expect(mean).toBeLessThan(52);
		for (const r of radii) expect(Math.abs(r - mean)).toBeLessThan(0.01);
	});

	it("fits a rotated ellipse with its axes and closure", () => {
		const phi = (30 * Math.PI) / 180;
		const points: InkPosition[] = [];
		for (let i = 0; i <= 96; i++) {
			const t = (2 * Math.PI * i) / 96;
			const ex = 80 * Math.cos(t) + 1.2 * Math.sin(7 * t),
				ey = 40 * Math.sin(t);
			points.push({
				x: 150 + ex * Math.cos(phi) - ey * Math.sin(phi),
				y: 120 + ex * Math.sin(phi) + ey * Math.cos(phi),
			});
		}
		const shape = expectShape(points);
		expect(dist(shape[0], shape[shape.length - 1])).toBeLessThan(1e-6);
		const radii = shape.map((p) => dist(p, { x: 150, y: 120 }));
		expect(Math.max(...radii)).toBeGreaterThan(76);
		expect(Math.max(...radii)).toBeLessThan(84);
		expect(Math.min(...radii)).toBeGreaterThan(36);
		expect(Math.min(...radii)).toBeLessThan(44);
	});

	it("snaps an axis-aligned rectangle started mid-edge to four right corners", () => {
		const points = wobble(
			[
				{ x: 80, y: 30 },
				{ x: 140, y: 30 },
				{ x: 140, y: 110 },
				{ x: 20, y: 110 },
				{ x: 20, y: 30 },
			],
			16,
			1.5,
			true,
		);
		const shape = expectShape(points);
		expect(dist(shape[0], shape[shape.length - 1])).toBeLessThan(1e-6);
		const angles = sharpCorners(shape);
		expect(angles).toHaveLength(4);
		for (const angle of angles) expect(Math.abs(angle - 90)).toBeLessThan(1);
		const xs = shape.map((p) => p.x),
			ys = shape.map((p) => p.y);
		expect(Math.min(...xs)).toBeCloseTo(20, 0);
		expect(Math.max(...xs)).toBeCloseTo(140, 0);
		expect(Math.min(...ys)).toBeCloseTo(30, 0);
		expect(Math.max(...ys)).toBeCloseTo(110, 0);
	});

	it("snaps a rotated rectangle without forcing it axis-aligned", () => {
		const theta = (12 * Math.PI) / 180,
			cos = Math.cos(theta),
			sin = Math.sin(theta);
		const rotate = (p: InkPosition) => ({
			x: 80 + (p.x - 80) * cos - (p.y - 70) * sin,
			y: 70 + (p.x - 80) * sin + (p.y - 70) * cos,
		});
		const points = wobble(
			[
				{ x: 20, y: 30 },
				{ x: 140, y: 30 },
				{ x: 140, y: 110 },
				{ x: 20, y: 110 },
			].map(rotate),
			16,
			1.5,
			true,
		);
		const shape = expectShape(points);
		const angles = sharpCorners(shape);
		expect(angles).toHaveLength(4);
		for (const angle of angles) expect(Math.abs(angle - 90)).toBeLessThan(1);
	});

	it("snaps a triangle to three straight edges", () => {
		const points = wobble(
			[
				{ x: 90, y: 120 },
				{ x: 150, y: 120 },
				{ x: 90, y: 30 },
				{ x: 30, y: 120 },
			],
			18,
			1.5,
			true,
		);
		const shape = expectShape(points);
		expect(dist(shape[0], shape[shape.length - 1])).toBeLessThan(1e-6);
		const angles = sharpCorners(shape);
		expect(angles).toHaveLength(3);
		expect(angles.reduce((s, a) => s + a, 0)).toBeCloseTo(180, 0);
	});

	it("normalizes a shaft with one barb into a symmetric arrow", () => {
		const points = wobble(
			[
				{ x: 10, y: 100 },
				{ x: 150, y: 100 },
				{ x: 132, y: 114 },
			],
			14,
			1,
			false,
		);
		const shape = expectShape(points);
		expect(shape[0]).toEqual({ x: 10, y: 100 });
		const tip = { x: 150, y: 100 };
		expect(shape.some((p) => dist(p, tip) < 0.01)).toBe(true);
		const barb = 22.8,
			angle = (26 * Math.PI) / 180;
		for (const sign of [1, -1]) {
			const end = {
				x: tip.x - barb * Math.cos(angle),
				y: tip.y + sign * barb * Math.sin(angle),
			};
			expect(shape.some((p) => dist(p, end) < 0.5)).toBe(true);
		}
	});

	it("keeps check marks, arcs, scribbles, dots and retrace lines as ink", () => {
		const check = wobble(
			[
				{ x: 10, y: 60 },
				{ x: 30, y: 90 },
				{ x: 90, y: 20 },
			],
			12,
			1,
			false,
		);
		expect(recognizeInkShape(check)).toBeNull();
		const arc: InkPosition[] = [];
		for (let i = 0; i <= 40; i++) {
			const t = (Math.PI / 2) * (i / 40);
			arc.push({ x: 60 * Math.cos(t), y: 60 * Math.sin(t) });
		}
		expect(recognizeInkShape(arc)).toBeNull();
		const zigzag: InkPosition[] = [];
		for (let i = 0; i <= 20; i++)
			zigzag.push({ x: i * 10, y: 50 + 25 * (i % 2 ? 1 : -1) });
		expect(recognizeInkShape(zigzag)).toBeNull();
		expect(
			recognizeInkShape([
				{ x: 10, y: 10 },
				{ x: 12, y: 11 },
				{ x: 11, y: 12 },
			]),
		).toBeNull();
		const retrace = wobble(
			[
				{ x: 10, y: 50 },
				{ x: 150, y: 50 },
				{ x: 12, y: 52 },
			],
			20,
			1,
			false,
		);
		expect(recognizeInkShape(retrace)).toBeNull();
	});

	it("does not mistake a diamond for a rectangle or an ellipse", () => {
		const points = wobble(
			[
				{ x: 100, y: 20 },
				{ x: 160, y: 100 },
				{ x: 100, y: 180 },
				{ x: 40, y: 100 },
			],
			16,
			1,
			true,
		);
		expect(recognizeInkShape(points)).toBeNull();
	});
});
