import { LoaderCircle, X } from "lucide-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { MobileDownloadSettings } from "@/components/mobile/mobile-download-settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const MobileSyncPane = lazy(() =>
	import("@/components/settings/panes/sync-pane").then((module) => ({
		default: module.SyncPane,
	})),
);

/** Reuses the desktop storage forms with tablet-safe backend capabilities. */
export function MobileSyncPanel({
	open,
	vaultPath,
	onOpenChange,
	onSynced,
}: {
	open: boolean;
	vaultPath: string | null;
	onOpenChange: (open: boolean) => void;
	onSynced: () => void | Promise<void>;
}) {
	const { t } = useTranslation("mobile");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				aria-describedby={undefined}
				className="mobile-safe-area flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:h-[min(90dvh,56rem)] sm:max-w-3xl sm:rounded-xl"
			>
				<DialogTitle className="sr-only">{t("sync.title")}</DialogTitle>
				<div className="flex shrink-0 justify-end px-4 pt-2">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-11"
						aria-label={t("sync.close")}
						onClick={() => onOpenChange(false)}
					>
						<X className="size-5" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6">
					<Suspense
						fallback={
							<div
								className="flex min-h-40 items-center justify-center gap-2 text-muted-foreground text-sm"
								role="status"
							>
								<LoaderCircle className="size-5 animate-spin" />
								{t("sync.loading")}
							</div>
						}
					>
						<MobileSyncPane vaultPath={vaultPath} mobile onSynced={onSynced} />
					</Suspense>
					<MobileDownloadSettings vaultPath={vaultPath} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
