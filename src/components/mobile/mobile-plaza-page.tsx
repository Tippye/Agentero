import { LoaderCircle } from "lucide-react";
import { Suspense, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PlazaTabView } from "@/components/plaza/plaza-tab-view";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	type MobilePlazaActions,
	openMobilePlazaUrl,
} from "@/lib/mobile/navigation";
import { PLAZA_SOURCES, plazaSourceForPath } from "@/lib/plaza/sources";

export type MobilePlazaPageProps = {
	active: boolean;
	vaultPath: string | null;
	/** Selected Plaza source path, owned by the header controls. */
	path: string;
	/** Incremented by the header reload action; remounts the current source. */
	reloadKey: number;
	onImportPaper: (reference: string) => void;
};

export function MobilePlazaPage({
	active,
	vaultPath,
	path,
	reloadKey,
	onImportPaper,
}: MobilePlazaPageProps) {
	const { t } = useTranslation("mobile");
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
				{/* Reload remounts the source so the web preview loads again. */}
				<PlazaTabView
					key={`${source.path}:${reloadKey}`}
					active={active}
					path={source.path}
					mobile={mobile}
					className="min-h-0 min-w-0 flex-1 [&_button]:min-h-11 [&_button]:min-w-11 [&_[role=combobox]]:min-h-11"
				/>
			</Suspense>
		</section>
	);
}
