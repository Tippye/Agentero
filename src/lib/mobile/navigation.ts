import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@/lib/core/tauri";
import { normalizeArxivId } from "@/lib/paper/arxiv";
import { visiblePaperTags } from "@/lib/paper/tags";
import type { PaperMetadata } from "@/lib/paper/types";

export type MobileNavigationTarget = "library" | "plaza" | "agent";
export type MobilePlazaActions = {
	vaultPath: string | null;
	/** Open the shared import review with this reference, without claiming an import. */
	onImportPaper: (reference: string) => void;
	onOpenUrl: (url: string) => void;
};
export function filterMobilePapers(
	papers: readonly PaperMetadata[],
	query: string,
	selectedTag: string | null = null,
): PaperMetadata[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	const tag = selectedTag?.trim().toLocaleLowerCase();
	return papers.filter((paper) => {
		const tags = visiblePaperTags(paper.tags);
		if (tag && !tags.some((item) => item.name.toLocaleLowerCase() === tag))
			return false;
		const text = [
			paper.title,
			...paper.authors,
			paper.year,
			paper.doi,
			paper.arxiv_id,
			...tags.map((item) => item.name),
		]
			.filter((value) => value !== null && value !== undefined)
			.join(" ")
			.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	});
}
export function mobilePaperTagCounts(
	papers: readonly PaperMetadata[],
): { name: string; count: number }[] {
	const counts = new Map<string, { name: string; count: number }>();
	for (const paper of papers)
		for (const tag of visiblePaperTags(paper.tags)) {
			const key = tag.name.toLocaleLowerCase();
			const previous = counts.get(key);
			if (previous) previous.count += 1;
			else counts.set(key, { name: tag.name, count: 1 });
		}
	return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** Seed identifier resolution when possible; generic discovery pages use reviewed title search. */
export function mobilePaperImportReference(input: {
	title: string;
	url?: string | null;
	arxivId?: string | null;
}): string {
	const url = input.url?.trim() ?? "";
	const arxiv = normalizeArxivId(input.arxivId ?? "") ?? normalizeArxivId(url);
	if (arxiv) return `arXiv:${arxiv}`;
	try {
		const parsed = new URL(url);
		if (
			["doi.org", "dx.doi.org"].includes(parsed.hostname) &&
			["http:", "https:"].includes(parsed.protocol)
		)
			return url;
	} catch {
		/* A title can still be reviewed. */
	}
	return input.title.trim() || url;
}
/** Mobile opens through the native plugin, never falling back to a dead WebView popup. */
export async function openMobilePlazaUrl(value: string): Promise<void> {
	const url = new URL(value);
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("Unsupported external link");
	if (isTauri()) {
		await openUrl(url.href);
		return;
	}
	// Ordinary browser previews use the browser's real link behavior.
	const link = document.createElement("a");
	link.href = url.href;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.click();
}
