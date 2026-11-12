/**
 * 广场（Plaza）center panel: one embedded source per tab.
 *
 * The tree root node is a plain virtual folder (expand/collapse only) with no
 * page of its own; each child row opens its source's tab. Everything is
 * derived from the {@link PLAZA_SOURCES} registry, so a new source needs no
 * changes here.
 */

import { useTranslation } from "react-i18next";
import { PlazaArxivRecView } from "@/components/plaza/plaza-arxiv-rec-view";
import { PlazaCcfDeadlinesView } from "@/components/plaza/plaza-ccf-deadlines-view";
import { PlazaFeedsView } from "@/components/plaza/plaza-feeds-view";
import { PlazaSkillsView } from "@/components/plaza/plaza-skills-view";
import { PlazaWebFrame } from "@/components/plaza/plaza-web-frame";
import { EmptyState } from "@/components/ui/empty-state";
import type { MobilePlazaActions } from "@/lib/mobile/navigation";
import { plazaSourceForPath, plazaSourceLabel } from "@/lib/plaza";

export function PlazaView({
	path,
	className,
	mobile,
}: {
	path: string;
	className?: string;
	mobile?: MobilePlazaActions;
}) {
	const { t } = useTranslation("sidebar");
	const source = plazaSourceForPath(path);

	if (source?.panel === "skills") {
		return <PlazaSkillsView className={className} mobile={mobile} />;
	}

	if (source?.panel === "feeds") {
		return <PlazaFeedsView className={className} mobile={mobile} />;
	}

	if (source?.panel === "arxivRec") {
		return (
			<PlazaArxivRecView
				key={mobile ? (mobile.vaultPath ?? "unavailable") : undefined}
				className={className}
				mobile={mobile}
			/>
		);
	}

	if (source?.panel === "ccfDeadlines") {
		return <PlazaCcfDeadlinesView className={className} mobile={mobile} />;
	}

	if (source?.url) {
		return (
			<PlazaWebFrame
				homeUrl={source.url}
				desktopWidth={source.desktopWidth}
				embedOrigin={mobile ? null : (source.embedOrigin?.() ?? null)}
				lastPathStorageKey={
					source.embedOrigin
						? `agentero:plaza:${source.id}:last-path`
						: undefined
				}
				title={plazaSourceLabel(source)}
				className={className}
				mobile={mobile}
			/>
		);
	}

	if (source) {
		return (
			<EmptyState className={className}>
				{t("plaza.comingSoonFor", { label: plazaSourceLabel(source) })}
			</EmptyState>
		);
	}

	// The Plaza root has no page of its own — it is a tree folder only.
	return null;
}
