import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t } from "i18next";
import { inkExportDestinationAllowed } from "@/lib/pdf/ink/export";

/** The iOS picker stages this basename in Documents before asking for a target. */
function copyName(suggestedName: string): string {
	const source = suggestedName
		.normalize("NFC")
		.replace(/\.pdf$/i, "")
		.replace(/[\\/:"*?<>|]/g, " ")
		.replace(/\p{Cc}/gu, " ")
		.replace(/^[.\s]+|[.\s]+$/g, "");
	let stem = "";
	const encoder = new TextEncoder();
	for (const character of source) {
		if (encoder.encode(stem + character).length > 128) break;
		stem += character;
	}
	return `${stem || "paper"}-annotated-${crypto.randomUUID()}.pdf`;
}

/** Native Save uses Android SAF URIs and iOS security-scoped file URLs. */
export async function exportMobileInkPdf(
	bytes: Uint8Array,
	suggestedName: string,
	protectedDirectory?: string,
): Promise<void> {
	const destination = await save({
		defaultPath: copyName(suggestedName),
		filters: [{ name: "PDF", extensions: ["pdf"] }],
	});
	if (!destination) return;
	if (
		protectedDirectory &&
		!inkExportDestinationAllowed(destination, protectedDirectory)
	) {
		throw new Error(t("viewer:ink.exportCopyOnly"));
	}
	// Keep the picker URI intact: plugin-fs owns SAF and security-scope access.
	await writeFile(destination, bytes);
}
