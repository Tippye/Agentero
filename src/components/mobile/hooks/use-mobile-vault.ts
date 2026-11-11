import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openMobileVault } from "@/lib/mobile/local-vault";
import { setVaultPath } from "@/lib/vault/store";

export function useMobileVault() {
	const { i18n } = useTranslation("mobile");
	const [vaultPath, setPath] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [attempt, setAttempt] = useState(0);
	const retry = useCallback(() => setAttempt((value) => value + 1), []);

	useEffect(() => {
		void attempt; // Explicit retry after a failed native open.
		let active = true;
		setLoading(true);
		void openMobileVault(i18n.language)
			.then((path) => {
				if (!active) return;
				// The shared editor and wiki persistence use this store, not settings.
				setVaultPath(path);
				setPath(path);
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
	}, [attempt, i18n.language]);

	return { vaultPath, loading, retry };
}
