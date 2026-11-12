import { X } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import type { MobilePaperRegionContext } from "@/lib/mobile/paper-context";

export type RemoteRegionContextPreviewProps = {
	context: MobilePaperRegionContext;
	includeImage: boolean;
	imageSupported: boolean;
	uncertain: boolean;
	uploaded: boolean;
	busy: boolean;
	onIncludeImage: (include: boolean) => void;
	onRemove: () => void;
	onInspect?: () => void;
};

/** Local review only. Rendering this card never stages a file or calls a provider. */
export function RemoteRegionContextPreview({
	context,
	includeImage,
	imageSupported,
	uncertain,
	uploaded,
	busy,
	onIncludeImage,
	onRemove,
	onInspect,
}: RemoteRegionContextPreviewProps) {
	const { t } = useTranslation("mobile");
	const checkboxId = useId();
	return (
		<fieldset
			className="min-w-0 space-y-1 rounded-lg border bg-muted/20 p-2"
			aria-label={t("paperContext.preview")}
		>
			<div className="flex items-center gap-2">
				{context.image.mimeType === "image/png" && (
					<Dialog>
						<DialogTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								className="size-14 shrink-0 p-0"
								aria-label={t("paperContext.imageAlt", {
									title: context.title,
									page: context.page,
								})}
							>
								<img
									className="size-14 rounded object-contain"
									src={`data:image/png;base64,${context.image.data}`}
									alt=""
								/>
							</Button>
						</DialogTrigger>
						<DialogContent className="max-h-[90dvh] w-[calc(100vw-2rem)] max-w-4xl overflow-y-auto sm:max-w-4xl">
							<DialogHeader>
								<DialogTitle>{t("paperContext.preview")}</DialogTitle>
								<DialogDescription>
									{context.title} ·{" "}
									{t("paperContext.page", { page: context.page })}
								</DialogDescription>
							</DialogHeader>
							<img
								className="max-h-[70dvh] w-full object-contain"
								src={`data:image/png;base64,${context.image.data}`}
								alt={t("paperContext.imageAlt", {
									title: context.title,
									page: context.page,
								})}
							/>
						</DialogContent>
					</Dialog>
				)}
				<div className="min-w-0 flex-1 text-sm">
					<p className="truncate font-medium">{context.title}</p>
					<p className="text-muted-foreground">
						{t("paperContext.page", { page: context.page })}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					className="min-h-11 min-w-11"
					disabled={busy}
					aria-label={t("paperContext.remove")}
					onClick={onRemove}
				>
					<X className="size-4" />
				</Button>
			</div>
			<label
				htmlFor={checkboxId}
				className="flex min-h-11 items-center gap-2 text-sm"
			>
				<input
					id={checkboxId}
					type="checkbox"
					checked={includeImage}
					disabled={busy || uncertain}
					onChange={(event) => onIncludeImage(event.target.checked)}
				/>
				{t("paperContext.includeImage")}
			</label>
			{!imageSupported && includeImage && (
				<p className="text-muted-foreground text-xs">
					{t("paperContext.referenceOnly")}
				</p>
			)}
			{uploaded && !uncertain && (
				<p className="text-muted-foreground text-xs">
					{t("paperContext.uploaded")}
				</p>
			)}
			{uncertain && (
				<div className="flex flex-wrap items-center gap-2" role="status">
					<p className="min-w-0 flex-1 text-muted-foreground text-xs">
						{t("paperContext.uncertain")}
					</p>
					{onInspect && (
						<Button
							type="button"
							variant="outline"
							className="min-h-11"
							disabled={busy}
							onClick={onInspect}
						>
							{t("remote.inspectReceipt")}
						</Button>
					)}
				</div>
			)}
		</fieldset>
	);
}
