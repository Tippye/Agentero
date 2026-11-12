import { BookOpen, Info, Search, Tag, WandSparkles } from "lucide-react";
import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MobileNav } from "@/components/mobile/mobile-nav";
import { PaperTitle } from "@/components/paper/paper-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/core/utils";
import {
	filterMobilePapers,
	type MobileNavigationTarget,
	mobilePaperTagCounts,
} from "@/lib/mobile/navigation";
import type { PaperMetadata } from "@/lib/paper/types";

export type { MobileNavigationTarget } from "@/lib/mobile/navigation";
export type MobileLibraryNavigationProps = {
	active: MobileNavigationTarget;
	onNavigate: (target: MobileNavigationTarget) => void;
	papers: PaperMetadata[];
	selectedPaperId?: string | null;
	onSelectPaper: (paper: PaperMetadata) => void;
	query: string;
	onQueryChange: (query: string) => void;
	selectedTag: string | null;
	onTagChange: (tag: string | null) => void;
	loading?: boolean;
	onImport?: () => void;
	onPaperInfo?: (paper: PaperMetadata) => void;
};

export function MobileLibraryNavigation({
	active,
	onNavigate,
	papers,
	selectedPaperId,
	onSelectPaper,
	query,
	onQueryChange,
	selectedTag,
	onTagChange,
	loading = false,
	onImport,
	onPaperInfo,
}: MobileLibraryNavigationProps) {
	const { t } = useTranslation("mobile");
	const searchId = useId();
	const filtered = useMemo(
		() => filterMobilePapers(papers, query, selectedTag),
		[papers, query, selectedTag],
	);
	const tags = useMemo(() => mobilePaperTagCounts(papers), [papers]);
	return (
		<div className="space-y-4">
			<MobileNav tab={active} onTab={onNavigate} variant="sidebar" />
			<section className="space-y-2" aria-label={t("tabs.library")}>
				<div className="flex min-h-11 items-center justify-between gap-2">
					<span className="font-medium text-sm">{t("tabs.library")}</span>
					{onImport && (
						<Button
							type="button"
							variant="ghost"
							className="min-h-11 min-w-11"
							aria-label={t("navigation.import")}
							onClick={onImport}
						>
							<WandSparkles className="size-4" />
						</Button>
					)}
				</div>
				<div className="relative">
					<Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
					<Input
						id={searchId}
						className="min-h-11 pl-9 text-base"
						type="search"
						placeholder={t("library.search")}
						aria-label={t("library.search")}
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
					/>
				</div>
				{(tags.length > 0 || selectedTag !== null) && (
					<fieldset
						className="flex max-h-40 min-w-0 flex-wrap gap-1 overflow-y-auto"
						aria-label={t("navigation.tags")}
					>
						<Button
							type="button"
							variant={selectedTag === null ? "secondary" : "ghost"}
							className="min-h-11 px-2 text-xs"
							aria-pressed={selectedTag === null}
							onClick={() => onTagChange(null)}
						>
							{t("navigation.allPapers")}
						</Button>
						{tags.map((tag) => (
							<Button
								key={tag.name.toLocaleLowerCase()}
								type="button"
								variant={
									selectedTag?.toLocaleLowerCase() ===
									tag.name.toLocaleLowerCase()
										? "secondary"
										: "ghost"
								}
								className="min-h-11 max-w-full gap-1 px-2 text-xs"
								aria-pressed={
									selectedTag?.toLocaleLowerCase() ===
									tag.name.toLocaleLowerCase()
								}
								onClick={() =>
									onTagChange(
										selectedTag?.toLocaleLowerCase() ===
											tag.name.toLocaleLowerCase()
											? null
											: tag.name,
									)
								}
							>
								<Tag className="size-3 shrink-0" />
								<span className="truncate">{tag.name}</span>
								<span className="text-muted-foreground tabular-nums">
									{tag.count}
								</span>
							</Button>
						))}
					</fieldset>
				)}
				{loading && papers.length === 0 ? (
					<p role="status" className="py-3 text-muted-foreground text-sm">
						{t("library.loading")}
					</p>
				) : (
					<ul className="max-h-72 space-y-0.5 overflow-y-auto overscroll-contain">
						{filtered.map((paper) => (
							<li key={paper.id} className="flex items-center gap-1">
								<button
									type="button"
									className={cn(
										"flex min-h-11 min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-3 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
										selectedPaperId === paper.id &&
											active === "library" &&
											"bg-muted font-medium",
									)}
									aria-current={
										selectedPaperId === paper.id && active === "library"
											? "page"
											: undefined
									}
									onClick={() => onSelectPaper(paper)}
								>
									<BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<span className="line-clamp-2 min-w-0">
										<PaperTitle text={paper.title} />
									</span>
								</button>
								{onPaperInfo && (
									<Button
										type="button"
										variant="ghost"
										className="min-h-11 min-w-11 shrink-0"
										aria-label={t("navigation.paperInfo", {
											title: paper.title,
										})}
										onClick={() => onPaperInfo(paper)}
									>
										<Info className="size-4" />
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
				{!loading && filtered.length === 0 && (
					<p className="py-3 text-muted-foreground text-sm">
						{t("library.empty")}
					</p>
				)}
			</section>
		</div>
	);
}
