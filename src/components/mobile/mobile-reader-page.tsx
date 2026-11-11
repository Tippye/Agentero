import { LoaderCircle } from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useMobileWorkspaceWidth } from "@/components/mobile/hooks/use-mobile-workspace-width";
import { MobileNotesEditor } from "@/components/mobile/mobile-notes-editor";
import { MobilePaneGroup } from "@/components/mobile/mobile-pane-group";
import type { MobileReaderMode } from "@/components/mobile/types";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/core/notify";
import { exportMobileInkPdf } from "@/lib/mobile/export-pdf";
import { loadMobilePaperPdf, mobilePaperPaths } from "@/lib/mobile/paper-files";
import type {
	MobileWorkspacePreset,
	MobileWorkspaceWidth,
} from "@/lib/mobile/workspace";
import type { PaperMetadata } from "@/lib/paper/types";

const MobilePdfViewer = lazy(() =>
	import("@/components/viewer/pdf/pdf-viewer").then((module) => ({
		default: module.PdfViewer,
	})),
);

export type MobileReaderPageProps = {
	paper: PaperMetadata;
	vaultPath: string;
	mode: MobileReaderMode;
	active: boolean;
	preset?: MobileWorkspacePreset;
	widthClass?: MobileWorkspaceWidth;
	onNotesDirtyChange: (dirty: boolean) => void;
	onInkDirtyChange?: (dirty: boolean) => void;
	onInkModeChange?: (active: boolean) => void;
	onInkExport?: (bytes: Uint8Array, suggestedName: string) => Promise<void>;
	fetchMissing?: (paper: PaperMetadata) => Promise<boolean>;
};

export function MobileReaderPage({
	paper,
	vaultPath,
	mode,
	active,
	preset = "read",
	widthClass: suppliedWidth,
	onNotesDirtyChange,
	onInkDirtyChange,
	onInkModeChange,
	onInkExport,
	fetchMissing,
}: MobileReaderPageProps) {
	const { t } = useTranslation("mobile");
	const measurement = useMobileWorkspaceWidth<HTMLElement>(
		suppliedWidth === undefined,
	);
	const widthClass = suppliedWidth ?? measurement.widthClass;
	const compare = widthClass !== "narrow" && preset === "compare";
	const notesVisible = compare || (widthClass === "narrow" && mode === "notes");
	const pdfVisible = compare || !notesVisible;
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

	const paperDirectory = paths?.paperAbsPath;
	const exportInk = useCallback(
		(bytes: Uint8Array, name: string) =>
			exportMobileInkPdf(bytes, name, paperDirectory),
		[paperDirectory],
	);

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
			ref={measurement.ref}
			data-reader-width={widthClass}
			className="h-full min-h-0 min-w-0"
		>
			<MobilePaneGroup
				id="mobile-document"
				layoutKey={`${widthClass}:${preset}:${mode}`}
				panes={[
					{
						id: "pdf",
						visible: pdfVisible,
						weight: 1,
						separatorLabel: t("workspace.resizeNotes"),
						content: pdfError ? (
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
										isActive={active && pdfVisible}
										onInkDirtyChange={onInkDirtyChange}
										onInkModeChange={onInkModeChange}
										onInkExport={onInkExport ?? exportInk}
										className="h-full"
									/>
								) : (
									<PdfLoading />
								)}
							</Suspense>
						),
					},
					{
						id: "notes",
						visible: notesVisible,
						weight: 1,
						content: paths ? (
							<MobileNotesEditor
								key={paths.notesPath}
								path={paths.notesPath}
								vaultPath={vaultPath}
								active={active && notesVisible}
								onDirtyChange={onNotesDirtyChange}
							/>
						) : (
							<div className="p-6 text-muted-foreground text-sm">
								{t("reader.pdfUnavailable")}
							</div>
						),
					},
				]}
			/>
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
