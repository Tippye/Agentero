import { LoaderCircle } from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { normalizePath } from "@/lib/core/path";
import { readVaultFile, vaultPathExists } from "@/lib/vault/fs";
import { vaultRelativePath } from "@/lib/vault/path";
import {
	type LinkFragment,
	type WikiNavTarget,
	wikiNavigationDestination,
} from "@/lib/wiki/api";
import { WikiNavContext } from "@/lib/wiki/nav-context";

const MobileMarkdownEditor = lazy(() =>
	import("@/components/editor/markdown-editor").then((module) => ({
		default: module.MarkdownEditor,
	})),
);

/** The mature editor owns debounce, source mode, and unmount flush. Reuse its
 * disk-conflict pipeline and expose its existing keep/load conflict controls. */
export function MobileNotesEditor({
	path,
	vaultPath,
	active,
	onDirtyChange,
}: {
	path: string;
	vaultPath: string;
	active: boolean;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const { t } = useTranslation("mobile");
	const [seed, setSeed] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);
	const [conflict, setConflict] = useState(false);
	const [loading, setLoading] = useState(true);
	const [attempt, setAttempt] = useState(0);
	const tabId = `mobile:${path}`;
	const [navigationIntent, setNavigationIntent] = useState<{
		id: number;
		fragment: LinkFragment;
	}>();
	const noteRelativePath = vaultRelativePath(vaultPath, path);
	const navigateWiki = useCallback(
		(nav: WikiNavTarget) => {
			const destination = wikiNavigationDestination(nav);
			if (
				destination &&
				!destination.warning &&
				noteRelativePath &&
				normalizePath(destination.path) === normalizePath(noteRelativePath)
			) {
				if (!destination.fragment) return; // This note is already open.
				if (destination.fragment.kind !== "annotation") {
					const fragment = destination.fragment;
					setNavigationIntent((previous) => ({
						id: (previous?.id ?? 0) + 1,
						fragment,
					}));
					return;
				}
			}
			notifyError(t("reader.linkUnavailable"));
		},
		[noteRelativePath, t],
	);
	const wikiContext = useMemo(
		() => ({
			vaultPath,
			mdFiles: noteRelativePath ? [noteRelativePath] : [],
			onWikiNavigate: navigateWiki,
		}),
		[vaultPath, noteRelativePath, navigateWiki],
	);

	useEffect(() => {
		void attempt; // Retry a read failure without opening a blank editable note.
		let mounted = true;
		setLoading(true);
		void (async () => {
			const markdown = (await vaultPathExists(path))
				? await readVaultFile(path)
				: "";
			if (mounted) setSeed(markdown);
		})()
			.catch((error) => {
				if (mounted) notifyError(errorText(error));
			})
			.finally(() => {
				if (mounted) setLoading(false);
			});
		return () => {
			mounted = false;
		};
	}, [path, attempt]);

	const persist = useCallback(
		async (file: string, markdown: string, lastSaved: string) => {
			try {
				const { persistFile } = await import("@/lib/workspace/persistence");
				const saved = await persistFile(file, markdown, lastSaved, tabId);
				if (!saved) {
					try {
						const disk = await readVaultFile(file);
						if (disk !== lastSaved) setConflict(true);
					} catch {
						// The shared pipeline already reported the write failure.
					}
				}
				return saved;
			} catch (error) {
				notifyError(errorText(error));
				return false;
			}
		},
		[tabId],
	);

	const resolveConflict = useCallback(
		(_id: string, action: "keep" | "load" | "hold", disk: string) => {
			setConflict(action === "hold");
			if (action === "load") {
				setSeed(disk);
				setReloadKey((key) => key + 1);
			}
		},
		[],
	);

	if (loading) return <NotesLoading />;
	if (seed === null) {
		return (
			<div className="grid h-full place-items-center p-6">
				<Button
					variant="outline"
					className="min-h-12"
					onClick={() => setAttempt((value) => value + 1)}
				>
					{t("local.retry")}
				</Button>
			</div>
		);
	}
	return (
		<WikiNavContext.Provider value={wikiContext}>
			<Suspense fallback={<NotesLoading />}>
				<MobileMarkdownEditor
					key={path}
					tabId={tabId}
					active={active}
					filePath={path}
					initialMarkdown={seed}
					reloadKey={reloadKey}
					navigationIntent={navigationIntent}
					showToolbar
					fontSize={16}
					onPersist={persist}
					onDirtyChange={onDirtyChange}
					saveConflict={conflict}
					onResolveSaveConflict={resolveConflict}
					className="h-full min-h-0"
				/>
			</Suspense>
		</WikiNavContext.Provider>
	);
}

function NotesLoading() {
	return (
		<div className="grid h-full place-items-center" role="status">
			<LoaderCircle className="size-5 animate-spin text-muted-foreground" />
		</div>
	);
}
