import { openUrl } from "@tauri-apps/plugin-opener";
import i18n from "@/i18n";
import { isBackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import {
	commands,
	events,
	type JobSnapshot,
	type LookupImportBatchResult_Serialize,
} from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { awaitTaskSettled, cancelTask, enqueueTask } from "@/lib/core/tasks";
import type { PaperMetadata } from "@/lib/paper/types";
import { paperFromWire } from "@/lib/paper/wire";
import { DEFAULT_TRANSLATOR_BASE_URL, loadSettings } from "@/lib/settings";

export type MobilePaperImportResult = LookupImportBatchResult_Serialize;

/** Match the desktop wand: spaces belong to titles and identifier lists. */
export function parsePaperImportTexts(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[\n\r,;，；]+/)
				.map((part) => part.trim())
				.filter(Boolean),
		),
	];
}

export function isPaperSkillSource(text: string): boolean {
	return /\bnpx\s+skills\b|\bskills\.sh\b|(?:https?:\/\/)?github\.com\//i.test(
		text,
	);
}

function invalidResult(): Error {
	return new Error(i18n.t("mobile:paperImport.invalidResult"));
}

function sameImport(job: JobSnapshot, vaultPath: string): boolean {
	// Root passes vaultEnsure's canonical identity. Bind both native identifiers
	// to that explicit resource, never to an arbitrary private-vault response.
	return (
		job.kind === "import" &&
		job.host === "host" &&
		job.vaultId === vaultPath &&
		job.vaultPath === vaultPath &&
		job.paperPath === "papers"
	);
}

/** Native JobCenter owns execution, cancellation and the OS finite-work lease.
 * vaultPath must be Root's canonical vaultEnsure identity. A raw alias fails
 * closed; closing the dialog does not cancel or replay the job. */
export async function importMobilePaperTexts({
	vaultPath,
	texts,
	signal,
	onJob,
	onProgress,
}: {
	vaultPath: string;
	texts: string[];
	signal?: AbortSignal;
	onJob?: (id: string) => void;
	onProgress?: (progress: number | null) => void;
}): Promise<MobilePaperImportResult> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	const inputs = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
	if (!inputs.length) throw new Error(i18n.t("sidebar:lookup.batchEmpty"));
	if (inputs.some(isPaperSkillSource))
		throw new Error(i18n.t("mobile:paperImport.unsupportedSkill"));
	let jobId: string | null = null;
	const stop = await events.jobProgress.listen(({ payload }) => {
		if (payload.taskId === jobId) onProgress?.(payload.progress);
	});
	const abort = () => {
		if (jobId) cancelTask(jobId);
	};
	try {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const job = await enqueueTask({
			kind: "import",
			vaultPath,
			path: "papers",
			params: {
				native: true,
				mode: "lookup",
				texts: inputs,
				translatorBaseUrl: DEFAULT_TRANSLATOR_BASE_URL,
				concurrency: loadSettings().batchImportConcurrency ?? null,
			},
		});
		if (!sameImport(job, vaultPath)) throw invalidResult();
		jobId = job.id;
		onJob?.(job.id);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const terminal = await awaitTaskSettled(job).catch(
			async (error: unknown) => {
				if (isBackgroundTaskCancelledError(error)) throw error;
				// A native all-error batch is Failed, but retains the detailed result.
				// Read that exact job; never turn a lost event into another import.
				const jobs = await callApiResult(() =>
					commands.jobList({ vaultPath, path: null }),
				).catch(() => null);
				const failed = jobs?.find(
					(snapshot) => snapshot.id === job.id && snapshot.state === "failed",
				);
				if (!failed) throw error;
				return failed;
			},
		);
		if (
			terminal.id !== job.id ||
			!sameImport(terminal, vaultPath) ||
			terminal.vaultPath !== job.vaultPath
		)
			throw invalidResult();
		const params = terminal.params;
		const result =
			params && typeof params === "object" && !Array.isArray(params)
				? params.result
				: null;
		if (
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			!Array.isArray(result.imported) ||
			!Array.isArray(result.searchCandidates) ||
			!Array.isArray(result.skipped) ||
			!Array.isArray(result.errors)
		)
			throw invalidResult();
		const batch = result as MobilePaperImportResult;
		return terminal.state === "failed" && terminal.error
			? { ...batch, errors: [...new Set([...batch.errors, terminal.error])] }
			: batch;
	} finally {
		signal?.removeEventListener("abort", abort);
		stop();
	}
}

/** Refresh only the explicitly selected local paper; never read a desktop
 * global vault selection or synthesize a changed catalog record. */
export async function readMobilePaper(
	vaultPath: string,
	path: string,
): Promise<PaperMetadata> {
	const paper = await callApi(() => commands.paperGet({ vaultPath, path }));
	if (paper.path !== path) throw invalidResult();
	return paperFromWire(paper);
}

export function paperJumpUrl(value: string | null | undefined): string | null {
	if (!value?.trim()) return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

/** Never navigate the WebView or fall back to window.open on native failure. */
export async function openMobilePaperLink(value: string): Promise<boolean> {
	const url = paperJumpUrl(value);
	if (!url) return false;
	await openUrl(url);
	return true;
}
