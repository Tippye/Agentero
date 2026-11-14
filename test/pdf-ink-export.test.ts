import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { PdfAnnotationSubtype, type PdfInkAnnoObject } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import { degrees, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
	exportInkPdfCopy,
	inkExportDestinationAllowed,
} from "@/lib/pdf/ink/export";
import type { InkShape } from "@/lib/pdf/ink/geometry";

const pen: InkShape = {
	id: "00000000-0000-4000-8000-000000000001",
	tool: "pen",
	color: [220, 20, 20, 255],
	baseWidth: 12,
	points: [
		{ x: 20, y: 30, pressure: 0.1, elapsedMs: 0, tilt: null },
		{ x: 80, y: 50, pressure: 1, elapsedMs: 20, tilt: [0, 0] },
		{ x: 150, y: 80, pressure: 0.3, elapsedMs: 40, tilt: null },
	],
};
const highlighter: InkShape = {
	...pen,
	id: "00000000-0000-4000-8000-000000000002",
	tool: "highlighter",
	color: [240, 180, 41, 85],
	baseWidth: 18,
	points: [
		{ ...pen.points[0], x: 20, y: 120 },
		{ ...pen.points[1], x: 160, y: 120 },
	],
};

describe("standard Ink PDF copy", () => {
	it("opens and paints pressure appearances in real PDFium on four offset-cropped/rotated pages without modifying source bytes", async () => {
		const original = await PDFDocument.create();
		for (const rotation of [0, 90, 180, 270]) {
			const page = original.addPage([600, 800]);
			page.setCropBox(30, 40, 200, 300);
			page.setRotation(degrees(rotation));
		}
		const source = await original.save(),
			before = source.slice();
		const pages = new Map(
			[1, 2, 3, 4].map((page) => [page, [pen, highlighter]]),
		);
		const copy = await exportInkPdfCopy(source, pages);
		expect(source).toEqual(before);
		const reopenedOriginal = await PDFDocument.load(source);
		expect(reopenedOriginal.getPage(0).node.Annots()).toBeUndefined();
		const reopenedCopy = await PDFDocument.load(copy);
		for (const page of reopenedCopy.getPages()) {
			const annotations = page.node.Annots();
			expect(annotations?.size()).toBe(2);
			const annotation = annotations?.lookup(0, PDFDict);
			expect(annotation?.get(PDFName.of("Subtype"))).toEqual(PDFName.of("Ink"));
			expect(annotation?.get(PDFName.of("AP"))).toBeDefined();
		}
		const engine = new PdfiumNative(
			await init({
				// Emscripten's WASI environment requires an ASCII program name;
				// Node's absolute test-runner path can contain non-ASCII folders.
				thisProgram: "pdfium-ink-test",
				wasmBinary: readFileSync(
					fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
				),
			}),
			{ fontFallback: null },
		);
		const document = await engine
			.openDocumentBuffer(
				{
					id: "ink-copy-independent-open",
					content: copy.slice().buffer as ArrayBuffer,
				},
				{ normalizeRotation: true },
			)
			.toPromise();
		try {
			for (const page of document.pages) {
				expect(page.size).toEqual({ width: 200, height: 300 });
				const annotations = await engine
					.getPageAnnotations(document, page)
					.toPromise();
				const ink = annotations.filter(
					(annotation): annotation is PdfInkAnnoObject =>
						annotation.type === PdfAnnotationSubtype.INK,
				);
				expect(ink).toHaveLength(2);
				expect(ink[0].inkList[0].points[0]).toEqual({ x: 20, y: 30 });
				const visible = await engine
					.renderPageRaw(document, page, {
						scaleFactor: 1,
						withAnnotations: true,
						rotation: page.rotation,
					})
					.toPromise();
				const hidden = await engine
					.renderPageRaw(document, page, {
						scaleFactor: 1,
						withAnnotations: false,
						rotation: page.rotation,
					})
					.toPromise();
				let colored = 0,
					red = 0,
					yellow = 0;
				for (let i = 0; i < visible.data.length; i += 4) {
					if (
						visible.data[i] !== hidden.data[i] ||
						visible.data[i + 1] !== hidden.data[i + 1] ||
						visible.data[i + 2] !== hidden.data[i + 2]
					)
						colored++;
					if (visible.data[i] > 150 && visible.data[i + 1] < 100) red++;
					if (
						visible.data[i] > 200 &&
						visible.data[i + 1] > 150 &&
						visible.data[i + 2] < 230
					)
						yellow++;
				}
				expect(colored).toBeGreaterThan(1000);
				expect(red).toBeGreaterThan(100);
				expect(yellow).toBeGreaterThan(500);
			}
		} finally {
			await engine.closeDocument(document).toPromise();
			await engine.destroy().toPromise();
		}
		if (process.env.AGENTERO_INK_QA_DIR) {
			writeFileSync(
				join(process.env.AGENTERO_INK_QA_DIR, "original.pdf"),
				source,
			);
			writeFileSync(
				join(process.env.AGENTERO_INK_QA_DIR, "pressure-ink-copy.pdf"),
				copy,
			);
		}
	}, 20000);

	it.each([
		["/vault/papers/a/source/paper.pdf", "/vault/papers/a", false],
		["/vault/papers/a/../a/source/paper.pdf", "/vault/papers/a", false],
		["file:///vault/papers/a/source/a%20paper.pdf", "/vault/papers/a", false],
		[
			"file:///vault/papers/a/%2e%2e/a/source/paper.pdf",
			"/vault/papers/a",
			false,
		],
		["C:\\Vault\\Papers\\A\\source\\paper.pdf", "c:/vault/papers/a", false],
		[
			"\\\\?\\C:\\Vault\\Papers\\A\\source\\paper.pdf",
			"C:/Vault/Papers/A",
			false,
		],
		[
			"\\\\?\\UNC\\server\\vault\\papers\\a\\paper.pdf",
			"\\\\server\\vault\\papers\\a",
			false,
		],
		[
			"file://server/vault/papers/a/paper.pdf",
			"\\\\server\\vault\\papers\\a",
			false,
		],
		["/exports/copy.pdf", "/vault/papers/a", true],
		["/vault/papers/ab/copy.pdf", "/vault/papers/a", true],
		[
			"content://com.android.providers.documents/tree/opaque",
			"/vault/papers/a",
			true,
		],
		["https://example.org/paper.pdf", "/vault/papers/a", false],
	])("protects original paper directory for destination %s", (destination, directory, allowed) => {
		expect(inkExportDestinationAllowed(destination, directory)).toBe(allowed);
	});
});
