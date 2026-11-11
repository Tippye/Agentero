import { commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import {
	createVaultDirectory,
	removeVaultPath,
	writeVaultBytes,
} from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";

/** Stage browser-selected files privately, then let the existing Host importer
 * own paper naming, metadata, deduplication and catalog writes. */
export async function importMobilePdfs(vaultPath: string, files: File[]) {
	const staging = joinVaultPath(
		vaultPath,
		`.agentero/import-tmp/${crypto.randomUUID()}`,
	);
	await createVaultDirectory(staging);
	const errors: string[] = [];
	let imported = 0;
	try {
		// Bound memory to one PDF, including on tablet file-provider selections.
		for (const [index, file] of files.entries()) {
			const filePath = joinVaultPath(staging, `${index}.pdf`);
			await writeVaultBytes(filePath, new Uint8Array(await file.arrayBuffer()));
			const result = await callApiResult(() =>
				commands.paperImportLocalPdf({
					vaultPath,
					parentDir: "papers",
					entries: [{ filePath, title: file.name.replace(/\.pdf$/i, "") }],
					filePaths: [],
					recognizeSync: false,
				}),
			);
			imported += result.papers.length;
			errors.push(...result.errors);
			await removeVaultPath(filePath);
		}
		return { imported, errors };
	} finally {
		// Only our unique staging directory; never remove an imported paper.
		await removeVaultPath(staging).catch(() => undefined);
	}
}
