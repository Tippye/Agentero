import { LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MobileNotesEditor } from "@/components/mobile/mobile-notes-editor";
import type { MobileReaderMode } from "@/components/mobile/types";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { loadMobilePaperPdf, mobilePaperPaths } from "@/lib/mobile/paper-files";
import type { PaperMetadata } from "@/lib/paper/types";

const MobilePdfViewer = lazy(() =>
	import("@/components/viewer/pdf/pdf-viewer").then((module) => ({
		default: module.PdfViewer,
	})),
);

export function MobileReaderPage({
	paper,
	vaultPath,
	mode,
	active,
	onNotesDirtyChange,
	fetchMissing,
}: {
	paper: PaperMetadata;
	vaultPath: string;
	mode: MobileReaderMode;
	active: boolean;
	onNotesDirtyChange: (dirty: boolean) => void;
	fetchMissing?: (paper: PaperMetadata) => Promise<boolean>;
}) {
	const { t } = useTranslation("mobile");
	const root = useRef<HTMLElement>(null);
	const [wide, setWide] = useState(false);
	const [pdf, setPdf] = useState<{
		source: string | null;
		bytes: ArrayBuffer | null;
	} | null>(null);
	const [pdfError, setPdfError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const paths = useMemo(() => {
		try {
			return mobilePaperPaths(vaultPath, paper);
		} catch {
			return null;
		}
	}, [vaultPath, paper]);

	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const measure = () => setWide(element.getBoundingClientRect().width >= 840);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		void attempt;
		let mounted = true;
		setPdf(null);
		setPdfError(null);
		void loadMobilePaperPdf(
			vaultPath,
			paper,
			fetchMissing ? () => fetchMissing(paper) : undefined,
		)
			.then((loaded) => {
				if (!mounted) return;
				if (!loaded.source && !loaded.bytes)
					setPdfError(t("reader.pdfUnavailable"));
				else setPdf(loaded);
			})
			.catch((error) => {
				if (mounted) {
					const message =
						error instanceof Error ? error.message : t("reader.pdfUnavailable");
					setPdfError(message);
					notifyError(message);
				}
			});
		return () => {
			mounted = false;
		};
	}, [vaultPath, paper, t, fetchMissing, attempt]);

	return (
		<section
			ref={root}
			className={cn(
				"flex h-full min-h-0",
				wide ? "flex-row divide-x" : "flex-col",
			)}
		>
			<div
				className={cn(
					"h-full min-h-0 min-w-0 flex-1",
					!wide && mode !== "pdf" && "hidden",
				)}
			>
				{pdfError ? (
					<div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-muted-foreground text-sm">
						{pdfError}
						<Button
							type="button"
							variant="outline"
							className="min-h-11"
							onClick={() => setAttempt((value) => value + 1)}
						>
							{t("local.retry")}
						</Button>
					</div>
				) : (
					<Suspense fallback={<PdfLoading />}>
						{pdf && paths ? (
							<MobilePdfViewer
								source={pdf.source}
								sourceBytes={pdf.bytes}
								docId={paths.paperAbsPath}
								paperRelPath={paths.paperRelPath}
								paperAbsPath={paths.paperAbsPath}
								vaultPath={vaultPath}
								isActive={active && (wide || mode === "pdf")}
								className="h-full"
							/>
						) : (
							<PdfLoading />
						)}
					</Suspense>
				)}
			</div>
			<div
				className={cn(
					"h-full min-h-0 min-w-0 flex-1",
					!wide && mode !== "notes" && "hidden",
				)}
			>
				{paths ? (
					<MobileNotesEditor
						key={paths.notesPath}
						path={paths.notesPath}
						vaultPath={vaultPath}
						active={active && (wide || mode === "notes")}
						onDirtyChange={onNotesDirtyChange}
					/>
				) : (
					<div className="p-6 text-muted-foreground text-sm">
						{t("reader.pdfUnavailable")}
					</div>
				)}
			</div>
		</section>
	);
}

function PdfLoading() {
	const { t } = useTranslation("mobile");
	return (
		<div
			className="grid h-full place-items-center text-muted-foreground text-sm"
			role="status"
		>
			<div className="flex items-center gap-2">
				<LoaderCircle className="size-5 animate-spin" />
				{t("reader.loadingPdf")}
			</div>
		</div>
	);
}
