import { getStroke } from "perfect-freehand";
import { shellFractionToUnrotatedPdf } from "@/lib/pdf/page-frame";

export type InkPosition = { x: number; y: number };
export type InkSample = InkPosition & {
	pressure: number | null;
	elapsedMs: number | null;
	tilt: [number, number] | null;
};
export type InkShape = {
	id: string;
	tool: "pen" | "highlighter";
	color: [number, number, number, number];
	baseWidth: number;
	points: InkSample[];
	createdAtMs?: string | null;
	updatedAtMs?: string | null;
};
export type InkBounds = { x: number; y: number; width: number; height: number };

/** Crop-relative, unrotated PDF points; CSS zoom and page /Rotate are removed. */
export function inkPointFromClient(
	client: InkPosition,
	box: { left: number; top: number; width: number; height: number },
	page: { width: number; height: number; rotation: number },
): InkPosition {
	const fraction = shellFractionToUnrotatedPdf(
		{
			x: (client.x - box.left) / box.width,
			y: (client.y - box.top) / box.height,
		},
		page.rotation,
		box.width,
		box.height,
		1,
	);
	return {
		x: Math.max(0, Math.min(page.width, fraction.x * page.width)),
		y: Math.max(0, Math.min(page.height, fraction.y * page.height)),
	};
}

export function inkPointerSample(
	event: Pick<
		PointerEvent,
		"pointerType" | "pressure" | "tiltX" | "tiltY" | "timeStamp"
	>,
	point: InkPosition,
	startedAt: number,
): InkSample {
	const pen = event.pointerType === "pen";
	return {
		...point,
		// Zero is a valid stylus sample; missing pressure is not zero.
		pressure:
			pen && Number.isFinite(event.pressure)
				? Math.max(0, Math.min(1, event.pressure))
				: null,
		elapsedMs: Math.max(
			0,
			Math.min(4294967295, Math.round(event.timeStamp - startedAt)),
		),
		tilt:
			pen && Number.isFinite(event.tiltX) && Number.isFinite(event.tiltY)
				? [
						Math.max(-90, Math.min(90, event.tiltX)),
						Math.max(-90, Math.min(90, event.tiltY)),
					]
				: null,
	};
}

/** Mature pressure outline renderer; the persistent model remains the original polyline. */
export function inkOutline(stroke: InkShape, complete = true): number[][] {
	return getStroke(
		stroke.points.map((p) => [p.x, p.y, p.pressure ?? 0.5]),
		{
			size: stroke.baseWidth,
			thinning: stroke.tool === "highlighter" ? 0 : 0.65,
			streamline: 0.15,
			smoothing: 0.5,
			simulatePressure: false,
			last: complete,
		},
	);
}

export function inkSvgPath(outline: number[][]): string {
	if (!outline.length) return "";
	return `${outline.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(3)},${y.toFixed(3)}`).join(" ")} Z`;
}

export function inkBounds(strokes: readonly InkShape[]): InkBounds | null {
	let left = Infinity,
		top = Infinity,
		right = -Infinity,
		bottom = -Infinity;
	for (const stroke of strokes) {
		for (const p of stroke.points) {
			left = Math.min(left, p.x - stroke.baseWidth / 2);
			top = Math.min(top, p.y - stroke.baseWidth / 2);
			right = Math.max(right, p.x + stroke.baseWidth / 2);
			bottom = Math.max(bottom, p.y + stroke.baseWidth / 2);
		}
	}
	return Number.isFinite(left)
		? { x: left, y: top, width: right - left, height: bottom - top }
		: null;
}

function segmentDistance(
	p: InkPosition,
	a: InkPosition,
	b: InkPosition,
): number {
	const dx = b.x - a.x,
		dy = b.y - a.y;
	const t =
		dx || dy
			? Math.max(
					0,
					Math.min(
						1,
						((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy),
					),
				)
			: 0;
	return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Whole-stroke eraser tests segments, including a dot, instead of only samples. */
export function inkHitStroke(
	stroke: InkShape,
	point: InkPosition,
	radius: number,
	previous: InkPosition = point,
): boolean {
	const cross = (a: InkPosition, b: InkPosition, c: InkPosition) =>
		(b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	return stroke.points.some((p, i) => {
		const a = stroke.points[Math.max(0, i - 1)];
		const crossing =
			cross(previous, point, a) * cross(previous, point, p) < 0 &&
			cross(a, p, previous) * cross(a, p, point) < 0;
		const distance = crossing
			? 0
			: Math.min(
					segmentDistance(point, a, p),
					segmentDistance(previous, a, p),
					segmentDistance(a, previous, point),
					segmentDistance(p, previous, point),
				);
		return distance <= radius + stroke.baseWidth / 2;
	});
}

export function inkPointInPolygon(
	point: InkPosition,
	polygon: readonly InkPosition[],
): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i],
			b = polygon[j];
		if (
			a.y > point.y !== b.y > point.y &&
			point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
		)
			inside = !inside;
	}
	return inside;
}

/** A lasso selects complete strokes contained by the closed loop. */
export function inkLassoIds(
	strokes: readonly InkShape[],
	polygon: readonly InkPosition[],
): string[] {
	if (polygon.length < 3) return [];
	return strokes
		.filter((stroke) =>
			stroke.points.every((p) => inkPointInPolygon(p, polygon)),
		)
		.map((stroke) => stroke.id);
}

export function moveInk(
	strokes: readonly InkShape[],
	delta: InkPosition,
	page: { width: number; height: number },
): InkShape[] {
	const bounds = inkBounds(strokes);
	if (!bounds) return [];
	const dx = Math.max(
		-bounds.x,
		Math.min(page.width - bounds.x - bounds.width, delta.x),
	);
	const dy = Math.max(
		-bounds.y,
		Math.min(page.height - bounds.y - bounds.height, delta.y),
	);
	return strokes.map((stroke) => ({
		...stroke,
		points: stroke.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
	}));
}
