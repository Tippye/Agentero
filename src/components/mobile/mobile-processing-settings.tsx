import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutPane } from "@/components/settings/panes/layout-pane";
import { TranslatePane } from "@/components/settings/panes/translate-pane";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { errorMessage, notifyError } from "@/lib/core/notify";
import {
	listenMobileProcessingSettings,
	type MobileProcessingSection,
} from "@/lib/mobile/processing-settings";
import {
	type AppSettings,
	loadSettings,
	saveSettingsAsync,
	subscribeSettings,
} from "@/lib/settings";

/** Mount once in MobileApp. Opening preserves the mounted reader and its draft. */
export function MobileProcessingSettings() {
	const { t } = useTranslation(["settings", "common"]);
	const [open, setOpen] = useState(false);
	const [section, setSection] = useState<MobileProcessingSection>("translate");
	const [settings, setSettings] = useState(loadSettings);
	useEffect(() => subscribeSettings(setSettings), []);
	useEffect(
		() =>
			listenMobileProcessingSettings((next) => {
				setSettings(loadSettings());
				setSection(next);
				setOpen(true);
			}),
		[],
	);
	const patch = useCallback((partial: Partial<AppSettings>) => {
		const next = { ...loadSettings(), ...partial };
		setSettings(next);
		void saveSettingsAsync(next).catch((error) =>
			notifyError(errorMessage(error)),
		);
	}, []);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				showCloseButton={false}
				aria-describedby={undefined}
				className="mobile-safe-area flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:h-[min(90dvh,56rem)] sm:max-w-3xl sm:rounded-xl"
			>
				<DialogTitle className="sr-only">{t("title")}</DialogTitle>
				<div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
					{(["translate", "layout"] as const).map((item) => (
						<Button
							key={item}
							className="min-h-11"
							variant={section === item ? "secondary" : "ghost"}
							aria-pressed={section === item}
							onClick={() => setSection(item)}
						>
							{t(`nav.${item}`)}
						</Button>
					))}
					<Button
						className="ml-auto size-11"
						variant="ghost"
						size="icon"
						aria-label={t("common:close")}
						onClick={() => setOpen(false)}
					>
						<X className="size-5" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 [&_button]:touch-manipulation [&_input]:min-h-11 [&_[data-slot=select-trigger]]:min-h-11 [&_[data-slot=select-trigger]]:min-w-0 [&_[data-slot=select-trigger]]:w-40 [&_[data-slot=select-trigger]]:max-w-[45vw]">
					{section === "translate" ? (
						<TranslatePane settings={settings} patch={patch} apiOnly />
					) : (
						<LayoutPane
							settings={settings}
							patch={patch}
							hostContext={{ kind: "local" }}
							apiOnly
						/>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
