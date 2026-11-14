import { ChevronUp, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useBackgroundTasks } from "@/hooks/use-background-tasks";
import {
	type BackgroundTask,
	cancelBackgroundTask,
} from "@/lib/core/background-tasks";
import { cn } from "@/lib/core/utils";

function isActive(task: BackgroundTask) {
	return task.status === "queued" || task.status === "running";
}

function TaskProgress({ task }: { task: BackgroundTask }) {
	const percent = task.progress;
	return (
		<span
			className="mt-1 block h-1 overflow-hidden rounded-full bg-muted"
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent == null ? undefined : Math.round(percent)}
		>
			<span
				className={cn(
					"block h-full rounded-full bg-primary transition-[width] duration-300",
					percent == null && "w-1/3 animate-pulse",
				)}
				style={percent == null ? undefined : { width: `${percent}%` }}
			/>
		</span>
	);
}

/**
 * Floating readout for Host/renderer tasks (translation, layout, imports).
 *
 * The tasks survive the reader: execution belongs to the app-level task
 * runtime, so this pill is the visible "still running in the background"
 * surface after the document unmounts.
 */
export function MobileTaskIndicator() {
	const { tasks } = useBackgroundTasks();
	const { t } = useTranslation("mobile");
	const [open, setOpen] = useState(false);
	const active = tasks.filter(isActive);
	const failed = tasks.filter((task) => task.status === "failed").slice(-1);
	const visible = [...active, ...failed];
	if (visible.length === 0) return null;
	const primary = visible[0];
	const percent =
		primary.progress == null ? null : Math.round(primary.progress);

	return (
		<div className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] left-3 z-30 max-w-[min(22rem,calc(100vw-1.5rem))]">
			<div className="overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur">
				<div className="flex items-stretch">
					<button
						type="button"
						className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left touch-manipulation"
						aria-expanded={open}
						aria-label={open ? t("tasks.hide") : t("tasks.show")}
						onClick={() => setOpen((value) => !value)}
					>
						{isActive(primary) ? (
							<LoaderCircle
								className="size-4 shrink-0 animate-spin text-primary"
								aria-hidden
							/>
						) : (
							<X className="size-4 shrink-0 text-destructive" aria-hidden />
						)}
						<span className="min-w-0 flex-1">
							<span className="flex items-center gap-1.5 text-xs font-medium">
								<span className="truncate">{primary.title}</span>
								{active.length > 1 ? (
									<span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">
										{active.length}
									</span>
								) : null}
							</span>
							{isActive(primary) ? (
								<TaskProgress task={primary} />
							) : (
								<span className="mt-0.5 block truncate text-[11px] text-destructive">
									{primary.error ?? primary.detail ?? ""}
								</span>
							)}
						</span>
						{isActive(primary) && percent != null ? (
							<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
								{percent}%
							</span>
						) : null}
						<ChevronUp
							className={cn(
								"size-3.5 shrink-0 text-muted-foreground transition-transform",
								open && "rotate-180",
							)}
							aria-hidden
						/>
					</button>
					{isActive(primary) ? (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-11 shrink-0 rounded-none border-l touch-manipulation"
							aria-label={t("tasks.cancel")}
							onClick={() => cancelBackgroundTask(primary.id)}
						>
							<X className="size-4" />
						</Button>
					) : null}
				</div>
				{open ? (
					<div className="max-h-60 overflow-y-auto overscroll-contain border-t">
						{visible.map((task) => {
							const activeTask = isActive(task);
							return (
								<div
									key={task.id}
									data-task-id={task.id}
									className="flex min-h-11 items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-xs font-medium">
											{task.title}
										</span>
										{activeTask ? (
											<TaskProgress task={task} />
										) : (
											<span className="mt-0.5 block truncate text-[11px] text-destructive">
												{task.error ?? task.detail ?? ""}
											</span>
										)}
									</span>
									{activeTask ? (
										<>
											{task.progress != null ? (
												<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
													{Math.round(task.progress)}%
												</span>
											) : null}
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="size-11 shrink-0 touch-manipulation"
												aria-label={t("tasks.cancel")}
												onClick={() => cancelBackgroundTask(task.id)}
											>
												<X className="size-4" />
											</Button>
										</>
									) : null}
								</div>
							);
						})}
					</div>
				) : null}
			</div>
		</div>
	);
}
