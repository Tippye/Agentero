import { LoaderCircle, WandSparkles } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PaperTitle } from "@/components/paper/paper-title";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { isBackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import {
	type ChatImportExtractResult,
	commands,
	type PaperSearchGroup,
} from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import {
	importMobilePaperTexts,
	isPaperSkillSource,
	type MobilePaperImportResult,
	parsePaperImportTexts,
} from "@/lib/mobile/paper-import";

export type MobilePaperImportProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vaultPath: string | null;
	onImported?: () => void | Promise<void>;
	initialText?: string;
};
type ReviewItem = { key: string; text: string };
function extractedItems(result: ChatImportExtractResult): ReviewItem[] {
	return [
		...result.arxiv.map((id) => ({ key: `arxiv:${id}`, text: `arXiv:${id}` })),
		...result.dois.map((id) => ({
			key: `doi:${id}`,
			text: `https://doi.org/${id}`,
		})),
		...result.pmids.map((id) => ({
			key: `pmid:${id}`,
			text: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
		})),
	];
}

export function MobilePaperImport(props: MobilePaperImportProps) {
	// Vault replacement discards only this view. Rust retains the old job.
	return <PaperImportBody key={props.vaultPath ?? ""} {...props} />;
}

function PaperImportBody({
	open,
	onOpenChange,
	vaultPath,
	onImported,
	initialText = "",
}: MobilePaperImportProps) {
	const { t } = useTranslation(["sidebar", "mobile", "common"]);
	const inputId = useId();
	const { isBlockedByIme, compositionProps } = useImeGuard();
	const [text, setText] = useState(initialText);
	const [review, setReview] = useState<ReviewItem[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [groups, setGroups] = useState<PaperSearchGroup[]>([]);
	const [result, setResult] = useState<MobilePaperImportResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<number | null>(null);
	const mounted = useRef(false);
	const busyRef = useRef(false);
	const resource = useRef(vaultPath);
	const generation = useRef(0);
	const previewed = useRef<string | null>(null);
	const cancellation = useRef<AbortController | null>(null);
	const imported = useRef(onImported);
	resource.current = vaultPath;
	imported.current = onImported;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (!open || busyRef.current) return;
		setText(initialText);
		setReview([]);
		setSelected(new Set());
		setGroups([]);
		setResult(null);
		previewed.current = null;
	}, [open, initialText]);
	useEffect(() => {
		const raw = text.trim();
		if (
			!open ||
			!raw ||
			busy ||
			previewed.current === raw ||
			parsePaperImportTexts(raw).some(isPaperSkillSource)
		)
			return;
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			void callApiResult(() => commands.chatImportExtract({ text: raw }))
				.then((found) => {
					if (controller.signal.aborted || busyRef.current) return;
					previewed.current = raw;
					const items = extractedItems(found);
					setReview(items.length >= 2 ? items : []);
					setSelected(new Set(items.map((item) => item.key)));
				})
				.catch(() => undefined); // Explicit submit surfaces lookup errors.
		}, 350);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [open, text, busy]);

	const run = async (choice?: { identifier: string; query: string }) => {
		if (!vaultPath || busyRef.current) return;
		const raw = text.trim();
		if (!choice && !raw) return;
		const current = ++generation.current;
		const sourceVault = vaultPath;
		const valid = () =>
			mounted.current &&
			resource.current === sourceVault &&
			generation.current === current;
		const controller = new AbortController();
		cancellation.current = controller;
		busyRef.current = true;
		setBusy(true);
		setProgress(null);
		try {
			let inputs = choice ? [choice.identifier] : parsePaperImportTexts(raw);
			if (inputs.some(isPaperSkillSource))
				throw new Error(t("mobile:paperImport.unsupportedSkill"));
			if (!choice && previewed.current !== raw) {
				const found = await callApiResult(() =>
					commands.chatImportExtract({ text: raw }),
				);
				if (!valid() || controller.signal.aborted) return;
				previewed.current = raw;
				const items = extractedItems(found);
				if (items.length >= 2) {
					setReview(items);
					setSelected(new Set(items.map((item) => item.key)));
					return;
				}
			}
			if (!choice && review.length >= 2)
				inputs = review
					.filter((item) => selected.has(item.key))
					.map((item) => item.text);
			if (!inputs.length || controller.signal.aborted) return;
			const next = await importMobilePaperTexts({
				vaultPath: sourceVault,
				texts: inputs,
				signal: controller.signal,
				onProgress: (value) => {
					if (valid()) setProgress(value);
				},
			});
			if (!valid()) return;
			setResult(next);
			setGroups((previous) => [
				...(choice
					? previous.filter((group) => group.query !== choice.query)
					: []),
				...next.searchCandidates,
			]);
			if (next.imported.some((paper) => paper.status !== "skipped"))
				await imported.current?.();
			if (valid() && next.imported.length && !next.searchCandidates.length) {
				setText("");
				setReview([]);
				setSelected(new Set());
				previewed.current = null;
			}
		} catch (error) {
			if (
				valid() &&
				!isBackgroundTaskCancelledError(error) &&
				!(error instanceof DOMException && error.name === "AbortError")
			)
				notifyError(errorText(error));
		} finally {
			if (valid()) {
				busyRef.current = false;
				cancellation.current = null;
				setBusy(false);
				setProgress(null);
			}
		}
	};
	const editText = (value: string) => {
		setText(value);
		setReview([]);
		setSelected(new Set());
		setGroups([]);
		setResult(null);
		previewed.current = null;
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="flex flex-col overflow-hidden sm:max-w-xl"
				style={{
					maxHeight:
						"calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 2rem)",
					top: "calc(50% + (env(safe-area-inset-top) - env(safe-area-inset-bottom)) / 2)",
				}}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<WandSparkles className="size-4" aria-hidden />
						{t("lookup.magicWand")}
					</DialogTitle>
					<DialogDescription>
						{t("mobile:paperImport.description")}
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain">
					<label htmlFor={inputId} className="sr-only">
						{t("lookup.magicWand")}
					</label>
					<Textarea
						id={inputId}
						value={text}
						disabled={busy || !vaultPath}
						placeholder={t("mobile:paperImport.placeholder")}
						className="min-h-28 text-base"
						{...compositionProps}
						onChange={(event) => editText(event.target.value)}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								(event.metaKey || event.ctrlKey) &&
								!isBlockedByIme(event)
							) {
								event.preventDefault();
								void run();
							}
						}}
					/>
					{!vaultPath ? (
						<p className="text-sm text-muted-foreground">
							{t("lookup.needsVault")}
						</p>
					) : null}
					{review.length >= 2 ? (
						<fieldset disabled={busy} className="space-y-1">
							<legend className="mb-2 text-sm font-medium">
								{t("lookup.chatFound", { count: review.length })}
							</legend>
							{review.map((item) => (
								<label
									key={item.key}
									htmlFor={`${inputId}-${item.key}`}
									className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-sm"
								>
									<Checkbox
										id={`${inputId}-${item.key}`}
										checked={selected.has(item.key)}
										onCheckedChange={(checked) =>
											setSelected((previous) => {
												const next = new Set(previous);
												if (checked) next.add(item.key);
												else next.delete(item.key);
												return next;
											})
										}
									/>
									<span className="min-w-0 break-all">{item.text}</span>
								</label>
							))}
						</fieldset>
					) : null}
					<div className="flex gap-2">
						<Button
							type="button"
							className="min-h-11 flex-1"
							disabled={
								busy ||
								!vaultPath ||
								!text.trim() ||
								(review.length >= 2 && !selected.size)
							}
							onClick={() => void run()}
						>
							{busy ? (
								<LoaderCircle className="size-4 animate-spin" aria-hidden />
							) : null}
							{busy
								? t("lookup.adding")
								: review.length >= 2
									? t("lookup.chatConfirm", { count: selected.size })
									: t("lookup.add")}
						</Button>
						{busy ? (
							<Button
								type="button"
								variant="outline"
								className="min-h-11"
								onClick={() => cancellation.current?.abort()}
							>
								{t("common:cancel")}
							</Button>
						) : null}
					</div>
					{busy && progress != null ? (
						<progress
							className="h-2 w-full"
							value={Math.max(0, Math.min(progress, 100))}
							max={100}
							aria-label={t("lookup.adding")}
						/>
					) : null}
					{groups.map((group) => (
						<section key={group.query} className="space-y-2">
							<h3 className="text-sm font-medium">
								{t("lookup.searchTitle", { query: group.query })}
							</h3>
							{group.candidates.map((candidate) => (
								<div
									key={candidate.identifier}
									className="flex items-start gap-3 rounded-md border p-3"
								>
									<div className="min-w-0 flex-1">
										<PaperTitle
											text={candidate.title}
											className="text-sm font-medium"
										/>
										<p className="mt-1 text-xs text-muted-foreground">
											{[
												candidate.authors.join(", "),
												candidate.year,
												candidate.venue,
											]
												.filter(Boolean)
												.join(" · ")}
										</p>
									</div>
									<Button
										type="button"
										variant="outline"
										className="min-h-11 shrink-0"
										disabled={busy}
										aria-label={`${t("lookup.searchConfirm")}: ${candidate.title}`}
										onClick={() =>
											void run({
												identifier: candidate.identifier,
												query: group.query,
											})
										}
									>
										{t("lookup.searchConfirm")}
									</Button>
								</div>
							))}
						</section>
					))}
					{result ? (
						<section aria-live="polite" className="space-y-2 text-sm">
							{result.imported.length ? (
								<p className="font-medium">
									{t("lookup.batchDone", { count: result.imported.length })}
								</p>
							) : !groups.length &&
								!result.errors.length &&
								!result.skipped.length ? (
								<p>{t("mobile:paperImport.noMatches")}</p>
							) : null}
							{result.imported.map((paper) => (
								<div key={paper.path} className="rounded-md border p-3">
									<PaperTitle text={paper.title} className="font-medium" />
									<p className="mt-1 text-xs text-muted-foreground">
										{t(
											paper.pdf
												? "mobile:paperImport.pdfSaved"
												: "mobile:paperImport.pdfMissing",
										)}
									</p>
									{paper.assetMessages?.map((message) => (
										<p
											key={message}
											className="mt-1 break-words text-xs text-muted-foreground"
										>
											{message}
										</p>
									))}
								</div>
							))}
							{[
								...new Map(
									result.skipped.map((item) => [JSON.stringify(item), item]),
								).values(),
							].map((item) => (
								<p
									key={JSON.stringify(item)}
									className="break-words text-muted-foreground"
								>
									{item.raw}: {item.reason}
								</p>
							))}
							{[...new Set(result.errors)].map((error) => (
								<p
									key={error}
									role="alert"
									className="break-words text-destructive"
								>
									{error}
								</p>
							))}
						</section>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
