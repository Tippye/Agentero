/**
 * Usage stats and batch cleanup for the reflow caches (IR pages + finished
 * translated PDFs) shown in Settings → About. Best-effort like the caches
 * themselves: a failed walk reports nothing instead of blocking the settings
 * pane, and `pdf-fonts/` is deliberately out of scope — fonts are content-pinned
 * assets, not per-paper state.
 *
 * IR pages stay in the app cache. Finished translated PDFs live in the paper's
 * `translated/` directory so vault sync can carry them, with the app cache as
 * the fallback for remote/pathless sessions.
 */

import { appCacheDir, join } from "@tauri-apps/api/path";
import { mkdir, readDir, remove, stat } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { isTauri } from "@/lib/core/tauri";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

const IR_DIR = "reflow-ir";
const BUILD_DIR = "reflow-build";
const TRANSLATED_DIR = "translated";

export type ReflowCacheUsage = { papers: number; bytes: number };

type CacheFile = { path: string; size: number };

async function walkFiles(dir: string): Promise<CacheFile[]> {
	const entries = await readDir(dir);
	const files: CacheFile[] = [];
	for (const entry of entries) {
		const path = await join(dir, entry.name);
		if (entry.isDirectory) files.push(...(await walkFiles(path)));
		else if (entry.isFile) {
			try {
				const info = await stat(path);
				files.push({ path, size: info.size });
			} catch {
				// A file vanishing between readDir and stat is fine.
			}
		}
	}
	return files;
}

/** Every local paper's finished-PDF directory; empty for remote vaults. */
async function translatedDirs(
	vaultPath: string | null | undefined,
): Promise<string[]> {
	if (!vaultPath || isRemoteVaultHandle(vaultPath)) return [];
	try {
		const papersDir = await join(vaultPath, "papers");
		const entries = await readDir(papersDir);
		const names = entries
			.filter((entry) => entry.isDirectory)
			.map((entry) => entry.name)
			.filter((name) => name !== "." && name !== ".." && !name.includes("/"));
		return Promise.all(
			names.map((name) => join(vaultPath, "papers", name, TRANSLATED_DIR)),
		);
	} catch {
		// Missing vault or papers/ contributes nothing.
		return [];
	}
}

/**
 * Aggregate usage across `reflow-ir/`, the fallback `reflow-build/` directory,
 * and every local paper's `translated/` directory. Paper count comes from the
 * IR subdirectories plus papers that only hold a finished PDF.
 * Returns null outside Tauri or when the app-cache walk fails.
 */
export async function reflowCacheUsage(
	vaultPath?: string | null,
): Promise<ReflowCacheUsage | null> {
	if (!isTauri()) return null;
	try {
		const cacheRoot = await appCacheDir();
		const irRoot = await join(cacheRoot, IR_DIR);
		const buildRoot = await join(cacheRoot, BUILD_DIR);
		const papers = new Set<string>();
		let bytes = 0;
		try {
			for (const entry of await readDir(irRoot)) {
				if (entry.isDirectory) papers.add(`ir:${entry.name}`);
			}
		} catch {
			// No IR cache yet.
		}
		for (const root of [irRoot, buildRoot]) {
			try {
				for (const file of await walkFiles(root)) bytes += file.size;
			} catch {
				// Missing directory contributes nothing.
			}
		}
		for (const dir of await translatedDirs(vaultPath)) {
			let files: CacheFile[] = [];
			try {
				files = await walkFiles(dir);
			} catch {
				// Paper never produced a finished PDF.
			}
			if (files.length === 0) continue;
			papers.add(`pdf:${dir}`);
			bytes += files.reduce((sum, file) => sum + file.size, 0);
		}
		return { papers: papers.size, bytes };
	} catch {
		return null;
	}
}

/**
 * Reveal the app cache folder that holds both fallback reflow roots. Creates
 * the roots first so the folder exists even before the first translation.
 */
export async function openReflowCacheFolder(): Promise<void> {
	if (!isTauri()) return;
	const cacheRoot = await appCacheDir();
	await Promise.all([
		mkdir(await join(cacheRoot, IR_DIR), { recursive: true }),
		mkdir(await join(cacheRoot, BUILD_DIR), { recursive: true }),
	]);
	await openPath(cacheRoot);
}

/**
 * Delete every cached file under both app-cache roots and every local paper's
 * `translated/` directory (the roots themselves stay; writers recreate content
 * on demand). Returns the bytes freed, computed before removal. Every removal
 * is attempted even if one fails.
 */
export async function clearReflowCaches(
	vaultPath?: string | null,
): Promise<number> {
	if (!isTauri()) return 0;
	const cacheRoot = await appCacheDir();
	const irRoot = await join(cacheRoot, IR_DIR);
	const buildRoot = await join(cacheRoot, BUILD_DIR);
	let freed = 0;
	let firstError: unknown;
	for (const root of [irRoot, buildRoot]) {
		let files: CacheFile[] = [];
		try {
			files = await walkFiles(root);
		} catch {
			continue;
		}
		freed += files.reduce((sum, file) => sum + file.size, 0);
		await Promise.all(
			files.map(async (file) => {
				try {
					await remove(file.path, { recursive: true });
				} catch (error) {
					firstError ??= error;
				}
			}),
		);
	}
	for (const dir of await translatedDirs(vaultPath)) {
		let files: CacheFile[] = [];
		try {
			files = await walkFiles(dir);
		} catch {
			continue;
		}
		freed += files.reduce((sum, file) => sum + file.size, 0);
		try {
			await remove(dir, { recursive: true });
		} catch (error) {
			firstError ??= error;
		}
	}
	if (firstError) throw firstError;
	return freed;
}
