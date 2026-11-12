import { ExternalLink, LoaderCircle, WandSparkles } from "lucide-react";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaTabView } from "@/components/plaza/plaza-tab-view";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	type MobilePlazaActions,
	openMobilePlazaUrl,
} from "@/lib/mobile/navigation";
import {
	PLAZA_SOURCES,
	plazaSourceForPath,
	plazaSourceLabel,
} from "@/lib/plaza/sources";

export type MobilePlazaPageProps = {
	active: boolean;
	vaultPath: string | null;
	onImportPaper: (reference: string) => void;
};

export function MobilePlazaPage({
	active,
	vaultPath,
	onImportPaper,
}: MobilePlazaPageProps) {
	const { t } = useTranslation("mobile");
	const [path, setPath] = useState(PLAZA_SOURCES[0].path);
	const source = plazaSourceForPath(path) ?? PLAZA_SOURCES[0];
	const onOpenUrl = useCallback(
		(url: string) => {
			void openMobilePlazaUrl(url).catch((error) =>
				notifyError(t("plaza.openFailed"), { description: errorText(error) }),
			);
		},
		[t],
	);
	const mobile = useMemo<MobilePlazaActions>(
		() => ({ vaultPath, onImportPaper, onOpenUrl }),
		[vaultPath, onImportPaper, onOpenUrl],
	);
	// Retain source choice, but do not mount a native panel or frame on a reading tab.
	if (!active) return null;
	return (
		<section
			className="flex h-full min-h-0 min-w-0 flex-col"
			aria-label={t("tabs.plaza")}
		>
			<div className="flex shrink-0 items-center gap-2 border-b p-2">
				<Select
					value={source.path}
					onValueChange={(next) => {
						if (plazaSourceForPath(next)) setPath(next);
					}}
				>
					<SelectTrigger
						className="min-h-11 min-w-0 flex-1"
						aria-label={t("plaza.source")}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent className="max-w-[calc(100vw-2rem)] [&_[role=option]]:min-h-11">
						{PLAZA_SOURCES.map((item) => (
							<SelectItem key={item.id} value={item.path}>
								{plazaSourceLabel(item)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{source.panel && source.url && (
					<Button
						type="button"
						variant="ghost"
						className="min-h-11 min-w-11"
						aria-label={t("plaza.openBrowser")}
						onClick={() => onOpenUrl(source.url ?? "")}
					>
						<ExternalLink className="size-4" />
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					className="min-h-11 min-w-11"
					disabled={!vaultPath}
					aria-label={t("navigation.import")}
					onClick={() => onImportPaper("")}
				>
					<WandSparkles className="size-4" />
				</Button>
			</div>
			<Suspense
				fallback={
					<div
						role="status"
						className="grid min-h-32 flex-1 place-items-center"
					>
						<LoaderCircle
							className="size-5 animate-spin"
							aria-label={t("plaza.loading")}
						/>
					</div>
				}
			>
				<PlazaTabView
					active={active}
					path={source.path}
					mobile={mobile}
					className="min-h-0 min-w-0 flex-1 [&_button]:min-h-11 [&_button]:min-w-11 [&_[role=combobox]]:min-h-11"
				/>
			</Suspense>
		</section>
	);
}
