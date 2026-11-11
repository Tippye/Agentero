import { mobilePaperPaths } from "@/lib/mobile/paper-files";
import { rescanPapers } from "@/lib/paper/api";
import type { PaperMetadata } from "@/lib/paper/types";
import {
	syncFetchPaper,
	syncGetDownloadPolicy,
	syncGetStatus,
	syncListPaperAvailability,
	syncSetDownloadPolicy,
} from "@/lib/sync/api";

/** The sync manifest identifies papers by their folder, not their catalog id. */
export function mobileSyncPaperId(
	vaultPath: string,
	paper: PaperMetadata,
): string {
	return mobilePaperPaths(vaultPath, paper).paperRelPath.split("/")[1];
}

const fetching = new Map<string, Promise<boolean>>();
const pinning = new Map<string, Promise<void>>();

/** One-shot materialization leaves both the download mode and pin set intact. */
export function fetchMobilePaperIfDeferred(
	vaultPath: string,
	paper: PaperMetadata,
): Promise<boolean> {
	const paths = mobilePaperPaths(vaultPath, paper);
	const current = fetching.get(paths.paperAbsPath);
	if (current) return current;
	const attempt = (async () => {
		const status = await syncGetStatus(vaultPath);
		if (
			!status.configured ||
			(status.config?.backend !== "s3" &&
				status.config?.backend !== "webdav") ||
			!status.config.scope.pdf
		)
			return false;
		const paperId = mobileSyncPaperId(vaultPath, paper);
		const inventory = await syncListPaperAvailability(vaultPath);
		if (
			!inventory.some(
				(item) =>
					item.paperId === paperId &&
					item.assets.some(
						(asset) => asset.kind === "pdf" && !asset.materialized,
					),
			)
		)
			return false;
		await syncFetchPaper(vaultPath, paperId);
		await rescanPapers(vaultPath);
		return true;
	})().finally(() => {
		fetching.delete(paths.paperAbsPath);
	});
	fetching.set(paths.paperAbsPath, attempt);
	return attempt;
}

/** Serialize read/modify/write policy updates so simultaneous pins cannot lose ids.
 * Unpinning changes future download intent only; it never evicts local files. */
export function setMobilePaperPinned(
	vaultPath: string,
	paper: PaperMetadata,
	pinned: boolean,
): Promise<void> {
	const paperId = mobileSyncPaperId(vaultPath, paper);
	const previous = pinning.get(vaultPath) ?? Promise.resolve();
	const attempt = previous
		.catch(() => {})
		.then(async () => {
			const policy = await syncGetDownloadPolicy(vaultPath);
			const ids = new Set(policy.pinnedPaperIds);
			if (pinned) ids.add(paperId);
			else ids.delete(paperId);
			await syncSetDownloadPolicy(vaultPath, {
				...policy,
				pinnedPaperIds: [...ids],
			});
			if (pinned) {
				await syncFetchPaper(vaultPath, paperId);
				await rescanPapers(vaultPath);
			}
		})
		.finally(() => {
			if (pinning.get(vaultPath) === attempt) pinning.delete(vaultPath);
		});
	pinning.set(vaultPath, attempt);
	return attempt;
}
