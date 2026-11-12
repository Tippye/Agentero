import { appDataDir } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { joinVaultPath } from "@/lib/vault/path";

let opening: Promise<string> | null = null;

/** Mobile owns one stable, app-private Vault; desktop restore paths are ignored. */
export function openMobileVault(locale: string): Promise<string> {
	if (opening) return opening;
	const attempt = (async () => {
		const path = joinVaultPath(await appDataDir(), "Vault");
		if (!(await exists(path))) {
			await callApi(() => commands.vaultCreate(path, locale));
		}
		const opened = await callApi(() => commands.vaultEnsure(path, locale));
		// Native facts and jobs use the canonical identity returned by ensure.
		return opened.path;
	})();
	opening = attempt;
	const settled = () => {
		if (opening === attempt) opening = null;
	};
	void attempt.then(settled, settled);
	return attempt;
}
