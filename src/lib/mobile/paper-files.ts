import {
	findLocalPdfPath,
	localFileToArrayBuffer,
	paperRemoteAssetsFromMetadata,
} from "@/lib/paper/media";
import type { PaperMetadata } from "@/lib/paper/types";
import { joinVaultPath } from "@/lib/vault/path";

/** Catalog paths are Vault-relative. Never give a malformed row FS access. */
export function mobilePaperPaths(vaultPath: string, paper: PaperMetadata) {
	const relative = paper.path?.replace(/\\/g, "/").replace(/^\.\//, "");
	if (
		!relative?.startsWith("papers/") ||
		relative.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error("Invalid paper path");
	}
	const paperAbsPath = joinVaultPath(vaultPath, relative);
	return {
		paperRelPath: relative,
		paperAbsPath,
		notesPath: joinVaultPath(paperAbsPath, "NOTES.md"),
	};
}

/** Offline bytes always win over a network candidate, without a HEAD probe. */
export async function loadMobilePaperPdf(
	vaultPath: string,
	paper: PaperMetadata,
) {
	const { paperAbsPath } = mobilePaperPaths(vaultPath, paper);
	const pdfPath = await findLocalPdfPath(paperAbsPath);
	if (pdfPath) {
		const bytes = await localFileToArrayBuffer(pdfPath);
		if (bytes) return { bytes, source: null };
	}
	return { bytes: null, source: paperRemoteAssetsFromMetadata(paper).pdfUrl };
}
