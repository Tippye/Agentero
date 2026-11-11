import { KeyRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	type BridgeClientStatus,
	bridgeResetIdentity,
} from "@/lib/bridge/client";
import { bridgeRecoveryKey } from "@/lib/bridge/recovery";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";

/** Explicit recovery, separate from stopping a transport connection. */
export function MobileBridgeReset({
	onStatus,
	onComplete,
}: {
	onStatus: (status: BridgeClientStatus) => void;
	onComplete?: () => void;
}) {
	const { t } = useTranslation("mobile");
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const reset = async () => {
		if (busy) return;
		setBusy(true);
		try {
			const next = await bridgeResetIdentity();
			onStatus(next);
			setOpen(false);
			onComplete?.();
		} catch (error) {
			const key = bridgeRecoveryKey(error);
			notifyError(key ? t(key) : errorText(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button
				variant="ghost"
				className="min-h-11 w-full justify-start gap-2"
				onClick={() => setOpen(true)}
			>
				<KeyRound className="size-4" />
				{t("connect.resetIdentity")}
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!busy) setOpen(next);
				}}
			>
				<DialogContent role="alertdialog" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>{t("connect.resetIdentity")}</DialogTitle>
						<DialogDescription>
							{t("connect.resetIdentityConfirm")}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							className="min-h-11"
							disabled={busy}
							onClick={() => setOpen(false)}
						>
							{t("connect.cancel")}
						</Button>
						<Button
							variant="destructive"
							className="min-h-11"
							disabled={busy}
							onClick={() => void reset()}
						>
							{t("connect.resetIdentity")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
