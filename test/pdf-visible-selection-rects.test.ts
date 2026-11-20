import { describe, expect, it } from "vitest";

import { mergeClientRectsIntoLines } from "@/lib/pdf/layout/visible-selection-rects";

describe("mergeClientRectsIntoLines", () => {
	it("joins character and sentence fragments on one line into a single band", () => {
		expect(
			mergeClientRectsIntoLines([
				{ left: 10, top: 20, width: 14, height: 16 },
				{ left: 28, top: 20, width: 14, height: 16 },
				{ left: 46, top: 21, width: 14, height: 16 },
			]),
		).toEqual([{ left: 10, top: 20, width: 50, height: 17 }]);
	});

	it("splits the strip where two stacked lines overlap", () => {
		expect(
			mergeClientRectsIntoLines([
				{ left: 10, top: 20, width: 80, height: 16 },
				{ left: 10, top: 30, width: 60, height: 16 },
			]),
		).toEqual([
			{ left: 10, top: 20, width: 80, height: 13 },
			{ left: 10, top: 33, width: 60, height: 13 },
		]);
	});

	it("keeps the next line and a distant column as separate bands", () => {
		expect(
			mergeClientRectsIntoLines([
				{ left: 10, top: 20, width: 40, height: 16 },
				{ left: 220, top: 20, width: 40, height: 16 },
				{ left: 10, top: 44, width: 40, height: 16 },
			]),
		).toEqual([
			{ left: 10, top: 20, width: 40, height: 16 },
			{ left: 220, top: 20, width: 40, height: 16 },
			{ left: 10, top: 44, width: 40, height: 16 },
		]);
	});
});
