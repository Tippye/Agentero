import { ExternalLink, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/core/utils";
import {
	PLAZA_SOURCES,
	plazaSourceForPath,
	plazaSourceLabel,
} from "@/lib/plaza/sources";

export type MobilePlazaControlsProps = {
	path: string;
	onPathChange: (path: string) => void;
	onReload: () => void;
	onOpenUrl: (url: string) => void;
	className?: string;
};

/**
 * Plaza source picker and icon actions for the mobile header row.
 *
 * Rendered as the header's trailing slot so the "Plaza" title, the source
 * picker, reload and open-in-browser all share one line. The page beneath only
 * owns the source content; reload remounts it (see MobilePlazaPage).
 */
export function MobilePlazaControls({
	path,
	onPathChange,
	onReload,
	onOpenUrl,
	className,
}: MobilePlazaControlsProps) {
	const { t } = useTranslation("mobile");
	const source = plazaSourceForPath(path) ?? PLAZA_SOURCES[0];
	const url = source.url;
	return (
		<div className={cn("flex min-w-0 items-center gap-1", className)}>
			<Select
				value={source.path}
				onValueChange={(next) => {
					if (plazaSourceForPath(next)) onPathChange(next);
				}}
			>
				<SelectTrigger
					className="min-h-11 w-28 min-w-0 shrink-0 [&_[data-slot=select-value]]:truncate sm:w-56"
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
			<Button
				type="button"
				variant="ghost"
				className="size-11 shrink-0 touch-manipulation"
				aria-label={t("plaza.refresh")}
				onClick={onReload}
			>
				<RotateCw className="size-4" />
			</Button>
			{url ? (
				<Button
					type="button"
					variant="ghost"
					className="size-11 shrink-0 touch-manipulation"
					aria-label={t("plaza.openBrowser")}
					onClick={() => onOpenUrl(url)}
				>
					<ExternalLink className="size-4" />
				</Button>
			) : null}
		</div>
	);
}
