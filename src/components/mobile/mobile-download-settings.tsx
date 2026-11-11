import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
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
	type DownloadPolicy,
	syncGetDownloadPolicy,
	syncSetDownloadPolicy,
} from "@/lib/sync/api";

export function MobileDownloadSettings({
	vaultPath,
}: {
	vaultPath: string | null;
}) {
	const { t } = useTranslation("mobile");
	const [policy, setPolicy] = useState<DownloadPolicy | null>(null);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		void attempt;
		let active = true;
		setPolicy(null);
		setLoading(true);
		if (!vaultPath) return;
		void syncGetDownloadPolicy(vaultPath)
			.then((next) => {
				if (active) setPolicy(next);
			})
			.catch((error) => {
				if (active) notifyError(errorText(error));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [vaultPath, attempt]);
	if (!vaultPath) return null;
	const chooseMode = async (mode: string) => {
		if (!policy || busy || (mode !== "full" && mode !== "onDemand")) return;
		setBusy(true);
		try {
			setPolicy(await syncSetDownloadPolicy(vaultPath, { ...policy, mode }));
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<SettingsGroup className="mt-5">
			<SettingsRow
				label={t("sync.downloads")}
				htmlFor="mobile-download-mode"
				className="flex-col items-stretch gap-2 sm:flex-row sm:items-center"
			>
				{policy ? (
					<Select
						value={policy.mode}
						onValueChange={(value) => void chooseMode(value)}
						disabled={busy}
					>
						<SelectTrigger
							id="mobile-download-mode"
							className="min-h-11 max-w-full"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent className="[&_[role=option]]:min-h-11">
							<SelectItem value="full">{t("sync.downloadFull")}</SelectItem>
							<SelectItem value="onDemand">
								{t("sync.downloadOnDemand")}
							</SelectItem>
						</SelectContent>
					</Select>
				) : loading ? (
					<span role="status" className="text-muted-foreground text-sm">
						{t("sync.loading")}
					</span>
				) : (
					<Button
						type="button"
						variant="outline"
						className="min-h-11"
						onClick={() => setAttempt((value) => value + 1)}
					>
						{t("local.retry")}
					</Button>
				)}
			</SettingsRow>
		</SettingsGroup>
	);
}
