import { PDFDocument, PDFHexString } from "pdf-lib";
import { visiblePageBox } from "@/lib/pdf/page-box";
import { type InkShape, inkOutline } from "./geometry";

/**
 * Add standard Ink annotations to a private PDF copy. Explicit normal appearances
 * preserve pressure outlines in readers that do not synthesize Ink appearances.
 * Source bytes, open viewer annotations, and sidecar files are never modified.
 */
export async function exportInkPdfCopy(
	source: Uint8Array,
	pages: ReadonlyMap<number, readonly InkShape[]>,
): Promise<Uint8Array> {
	const pdf = await PDFDocument.load(source.slice());
	for (const [pageNumber, strokes] of pages) {
		if (pageNumber < 1 || pageNumber > pdf.getPageCount())
			throw new Error("Ink page outside source PDF");
		const page = pdf.getPage(pageNumber - 1);
		const crop = visiblePageBox(page);
		for (const stroke of strokes) {
			if (!stroke.points.length) continue;
			const outline = inkOutline(stroke).map(([x, y]) => [
				crop.x + x,
				crop.y + crop.height - y,
			]);
			if (!outline.length) continue;
			const left = Math.min(...outline.map(([x]) => x));
			const bottom = Math.min(...outline.map(([, y]) => y));
			const right = Math.max(...outline.map(([x]) => x));
			const top = Math.max(...outline.map(([, y]) => y));
			const width = Math.max(0.01, right - left),
				height = Math.max(0.01, top - bottom);
			const [r, g, b, a] = stroke.color;
			const opacity = a / 255;
			const path = outline
				.map(
					([x, y], index) =>
						`${(x - left).toFixed(4)} ${(y - bottom).toFixed(4)} ${index ? "l" : "m"}`,
				)
				.join("\n");
			const graphicsState = pdf.context.obj({
				Type: "ExtGState",
				ca: opacity,
				CA: opacity,
				BM: stroke.tool === "highlighter" ? "Multiply" : "Normal",
			});
			const appearance = pdf.context.flateStream(
				`q\n/GS gs\n${r / 255} ${g / 255} ${b / 255} rg\n${path}\nh f\nQ`,
				{
					Type: "XObject",
					Subtype: "Form",
					FormType: 1,
					BBox: [0, 0, width, height],
					Resources: { ExtGState: { GS: graphicsState } },
				},
			);
			const inkList = stroke.points.flatMap((p) => [
				crop.x + p.x,
				crop.y + crop.height - p.y,
			]);
			if (stroke.points.length === 1)
				inkList.push(inkList[0] + 0.001, inkList[1]);
			const annotation = pdf.context.obj({
				Type: "Annot",
				Subtype: "Ink",
				P: page.ref,
				Rect: [left, bottom, left + width, bottom + height],
				InkList: [inkList],
				BS: { W: stroke.baseWidth, S: "S" },
				C: [r / 255, g / 255, b / 255],
				CA: opacity,
				F: 4,
				NM: PDFHexString.fromText(stroke.id),
				AP: { N: pdf.context.register(appearance) },
			});
			page.node.addAnnot(pdf.context.register(annotation));
		}
	}
	// Do not flatten: other readers retain editable, portable standard Ink.
	return pdf.save();
}

function destinationPath(path: string): string | null {
	let value = path;
	if (/^file:/i.test(value)) {
		try {
			const url = new URL(value);
			value = `${url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : ""}${decodeURIComponent(url.pathname)}`;
		} catch {
			return null;
		}
	}
	value = value.replace(/\\/g, "/");
	value = value
		.replace(/^\/\/\?\/UNC\//i, "//")
		.replace(/^\/\/\?\//, "")
		.replace(/^\/([a-z]:\/)/i, "$1");
	if (!value.startsWith("/") && !/^[a-z]:\//i.test(value)) return null;
	const parts: string[] = [];
	for (const part of value.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length || /^[a-z]:$/i.test(parts.at(-1) ?? "")) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.join("/").normalize("NFC").toLowerCase();
}

/** Native picker content URIs stay opaque; local paths may not overwrite any paper source. */
export function inkExportDestinationAllowed(
	destination: string,
	paperAbsPath: string,
): boolean {
	if (/^content:\/\//i.test(destination)) return true;
	const target = destinationPath(destination),
		folder = destinationPath(paperAbsPath);
	return (
		target !== null &&
		folder !== null &&
		target !== folder &&
		!target.startsWith(`${folder}/`)
	);
}
