import simplify from "simplify-js";
import type { InkPosition } from "./geometry";

/**
 * PencilKit-style "draw and hold" recognition: one freehand stroke that pauses
 * without lifting snaps to a clean shape. Pure geometry in unrotated PDF point
 * space; returns a normalized polyline (closed shapes repeat the first point)
 * or null when the stroke is not a confident match, so handwriting and
 * unfinished sketches stay as ink.
 *
 * Ramer–Douglas–Peucker simplification (simplify-js, MIT) classifies the stroke
 * by its dominant corners; every candidate is then verified against the
 * original samples before snapping. ML recognizers (e.g. desert-ant-labs
 * shapes) were rejected: heavy WASM payload and a restrictive source-available
 * license.
 */

/** Marks smaller than this are dots, not shapes. */
const MIN_SIZE_PT = 12;
const SIMPLIFY_RATIO = 0.02;
const MIN_TOLERANCE_PT = 1.5;
const CLOSE_RATIO = 0.1;
const MIN_CLOSE_PT = 8;
const ELLIPSE_SAMPLES = 48;

const dist = (a: InkPosition, b: InkPosition) =>
	Math.hypot(b.x - a.x, b.y - a.y);

/** Interior angle in degrees at b; a straight pass-through is 180. */
function cornerAngle(a: InkPosition, b: InkPosition, c: InkPosition): number {
	const ax = a.x - b.x,
		ay = a.y - b.y,
		cx = c.x - b.x,
		cy = c.y - b.y;
	const na = Math.hypot(ax, ay),
		nc = Math.hypot(cx, cy);
	if (na < 1e-6 || nc < 1e-6) return 180;
	const cos = Math.max(-1, Math.min(1, (ax * cx + ay * cy) / (na * nc)));
	return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Dense edge samples with near-corner duplicates keep snapped corners crisp
 * under the freehand renderer's smoothing instead of beveling them.
 */
function densify(
	vertices: readonly InkPosition[],
	closed: boolean,
): InkPosition[] {
	const out: InkPosition[] = [];
	const push = (p: InkPosition) => {
		const last = out.at(-1);
		if (!last || dist(last, p) > 1e-3) out.push(p);
	};
	const edges = closed ? vertices.length : vertices.length - 1;
	for (let i = 0; i < edges; i++) {
		const a = vertices[i],
			b = vertices[(i + 1) % vertices.length];
		const len = dist(a, b);
		if (len < 1e-6) continue;
		const ux = (b.x - a.x) / len,
			uy = (b.y - a.y) / len;
		const eps = Math.min(0.75, len / 4);
		push(a);
		push({ x: a.x + ux * eps, y: a.y + uy * eps });
		for (let t = 8; t < len - eps; t += 8)
			push({ x: a.x + ux * t, y: a.y + uy * t });
		push({ x: b.x - ux * eps, y: b.y - uy * eps });
		push(b);
	}
	return out;
}

/** Symmetric arrowhead on the drawn shaft; the barb length follows the sketch. */
function arrow(
	start: InkPosition,
	tip: InkPosition,
	barbLength: number,
): InkPosition[] {
	const len = dist(start, tip);
	const ux = (tip.x - start.x) / len,
		uy = (tip.y - start.y) / len;
	const angle = (26 * Math.PI) / 180,
		cos = Math.cos(angle),
		sin = Math.sin(angle);
	const length = Math.max(6, Math.min(barbLength, len * 0.35));
	const barb = (sign: number) => ({
		x: tip.x - length * (ux * cos - sign * uy * sin),
		y: tip.y - length * (uy * cos + sign * ux * sin),
	});
	return densify([start, tip, barb(1), tip, barb(-1)], false);
}

/** Open strokes: a long shaft with one or two short fold-back barbs. */
function arrowFrom(
	v: readonly InkPosition[],
	tolerance: number,
): InkPosition[] | null {
	const shaft = dist(v[0], v[1]);
	if (shaft < MIN_SIZE_PT) return null;
	const minBarb = Math.max(4, shaft * 0.05);
	if (v.length === 3) {
		const barb = dist(v[1], v[2]);
		if (barb > 0.4 * shaft || barb < minBarb) return null;
		// A check mark or an L turns far less sharply than an arrowhead.
		if (cornerAngle(v[0], v[1], v[2]) > 40) return null;
		return arrow(v[0], v[1], barb);
	}
	if (v.length === 5 && dist(v[1], v[3]) <= Math.max(2, tolerance * 1.5)) {
		const first = dist(v[1], v[2]),
			second = dist(v[3], v[4]);
		if (Math.max(first, second) > 0.45 * shaft) return null;
		if (Math.min(first, second) < minBarb) return null;
		if (
			cornerAngle(v[0], v[1], v[2]) > 60 ||
			cornerAngle(v[2], v[3], v[4]) > 60
		)
			return null;
		return arrow(v[0], v[1], (first + second) / 2);
	}
	return null;
}

/** Quadrilateral with near-right angles snaps to its rotated bounding box. */
function fitRectangle(
	corners: readonly InkPosition[],
	diag: number,
): InkPosition[] | null {
	for (let i = 0; i < 4; i++) {
		const angle = cornerAngle(
			corners[(i + 3) % 4],
			corners[i],
			corners[(i + 1) % 4],
		);
		if (angle < 65 || angle > 115) return null;
	}
	let edge = 0,
		longest = -1;
	for (let i = 0; i < 4; i++) {
		const len = dist(corners[i], corners[(i + 1) % 4]);
		if (len > longest) {
			longest = len;
			edge = i;
		}
	}
	const a = corners[edge],
		b = corners[(edge + 1) % 4];
	const theta = Math.atan2(b.y - a.y, b.x - a.x),
		cos = Math.cos(theta),
		sin = Math.sin(theta);
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of corners) {
		const rx = p.x * cos + p.y * sin,
			ry = -p.x * sin + p.y * cos;
		minX = Math.min(minX, rx);
		minY = Math.min(minY, ry);
		maxX = Math.max(maxX, rx);
		maxY = Math.max(maxY, ry);
	}
	if (Math.min(maxX - minX, maxY - minY) < Math.max(6, diag * 0.06))
		return null;
	const unrotated = (rx: number, ry: number) => ({
		x: rx * cos - ry * sin,
		y: rx * sin + ry * cos,
	});
	const fitted = [
		unrotated(minX, minY),
		unrotated(maxX, minY),
		unrotated(maxX, maxY),
		unrotated(minX, maxY),
	];
	// A diamond or parallelogram can pass the angle gate; its corners still
	// sit far from the fitted rectangle's corners, so require a close pairing.
	const tolerance = Math.max(4, diag * 0.08);
	const taken = new Set<number>();
	for (const corner of corners) {
		let best = -1,
			bestDistance = Infinity;
		for (let i = 0; i < 4; i++) {
			if (taken.has(i)) continue;
			const d = dist(corner, fitted[i]);
			if (d < bestDistance) {
				bestDistance = d;
				best = i;
			}
		}
		if (best < 0 || bestDistance > tolerance) return null;
		taken.add(best);
	}
	return densify(fitted, true);
}

/**
 * Closed round strokes: principal-axis frame from the sample covariance, then
 * a normalized-radius residual and angular coverage check. Near-equal axes
 * snap to a perfect circle; a square or diamond fails the residual.
 */
function fitEllipse(points: readonly InkPosition[]): InkPosition[] | null {
	// A closed stroke repeats its first sample at the end; counting it twice
	// would bias the fitted center toward the seam.
	const samples =
		dist(points[0], points[points.length - 1]) < 1e-6
			? points.slice(0, -1)
			: points;
	const n = samples.length;
	let cx = 0,
		cy = 0;
	for (const p of samples) {
		cx += p.x;
		cy += p.y;
	}
	cx /= n;
	cy /= n;
	let sxx = 0,
		syy = 0,
		sxy = 0;
	for (const p of samples) {
		const dx = p.x - cx,
			dy = p.y - cy;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy),
		ux = Math.cos(phi),
		uy = Math.sin(phi);
	let a = 0,
		b = 0;
	const projected = samples.map((p) => {
		const dx = p.x - cx,
			dy = p.y - cy;
		const pu = dx * ux + dy * uy,
			pv = -dx * uy + dy * ux;
		a = Math.max(a, Math.abs(pu));
		b = Math.max(b, Math.abs(pv));
		return { pu, pv };
	});
	if (Math.min(a, b) < 4) return null;
	const circle = Math.abs(a - b) <= 0.12 * Math.max(a, b);
	const ra = circle ? (a + b) / 2 : a,
		rb = circle ? (a + b) / 2 : b;
	let sum = 0,
		worst = 0;
	const bins = new Set<number>();
	for (const { pu, pv } of projected) {
		const dev = Math.abs(Math.hypot(pu / ra, pv / rb) - 1);
		sum += dev;
		worst = Math.max(worst, dev);
		const t = Math.atan2(pv / rb, pu / ra);
		bins.add(Math.floor(((t + Math.PI) / (2 * Math.PI)) * 8) % 8);
	}
	// A full loop with a small closure gap still covers at least 7 of 8 bins.
	if (sum / n > 0.08 || worst > 0.22 || bins.size < 7) return null;
	const start = Math.atan2(projected[0].pv / rb, projected[0].pu / ra);
	const out: InkPosition[] = [];
	for (let i = 0; i < ELLIPSE_SAMPLES; i++) {
		const t = start + (2 * Math.PI * i) / ELLIPSE_SAMPLES,
			ex = ra * Math.cos(t),
			ey = rb * Math.sin(t);
		out.push({ x: cx + ex * ux - ey * uy, y: cy + ex * uy + ey * ux });
	}
	out.push({ ...out[0] });
	return out;
}

export function recognizeInkShape(
	points: readonly InkPosition[],
): InkPosition[] | null {
	if (points.length < 2) return null;
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of points) {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	const diag = Math.hypot(maxX - minX, maxY - minY);
	if (diag < MIN_SIZE_PT) return null;
	const tolerance = Math.max(MIN_TOLERANCE_PT, diag * SIMPLIFY_RATIO);
	const simplified = simplify(points as InkPosition[], tolerance, true);
	if (simplified.length < 2) return null;
	const first = simplified[0],
		last = simplified[simplified.length - 1];
	const closed =
		dist(first, last) <= Math.max(MIN_CLOSE_PT, diag * CLOSE_RATIO);
	if (!closed) {
		// RDP already bounds every sample's deviation from the two endpoints.
		if (simplified.length === 2) return [{ ...first }, { ...last }];
		return arrowFrom(simplified, tolerance);
	}
	// Closed loop: drop the duplicated endpoint, then merge a flat seam when
	// the pen started mid-edge instead of at a corner.
	let corners = simplified.slice(0, -1);
	if (
		corners.length >= 3 &&
		cornerAngle(corners[corners.length - 1], corners[0], corners[1]) > 150
	)
		corners = corners.slice(1);
	if (
		corners.length === 3 &&
		corners.every((corner, i) => {
			const angle = cornerAngle(
				corners[(i + 2) % 3],
				corner,
				corners[(i + 1) % 3],
			);
			return angle >= 10 && angle <= 160;
		})
	)
		return densify(corners, true);
	if (corners.length === 4) {
		const rectangle = fitRectangle(corners, diag);
		if (rectangle) return rectangle;
	}
	return fitEllipse(points);
}
