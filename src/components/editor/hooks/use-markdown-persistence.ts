"use client";

import { MarkdownPlugin } from "@platejs/markdown";
import type { PlateEditor } from "platejs/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useDebouncedCallback } from "@/hooks/use-debounce";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { scheduleIdle } from "@/lib/core/idle";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import {
	frontmatterInterior,
	joinFrontmatter,
	splitFrontmatter,
	wrapFrontmatter,
} from "@/lib/markdown/frontmatter";
import {
	collectImageUrlCounts,
	createManagedAssetGc,
} from "@/lib/markdown/image";
import { settleMarkdownSaveAttempt } from "@/lib/markdown/save-state";
import { stripInlinePlaceholders } from "@/lib/markdown/serialize";
import { applySourceProjection } from "@/lib/markdown/source-projection";
import { isPreservedVaultWriteConflict, writeVaultFile } from "@/lib/vault/fs";
import { parseRemoteJoinedPath } from "@/lib/vault/remote/remote-vault";

const CHANGE_DEBOUNCE_MS = 500;

type UseMarkdownPersistenceOptions = {
	editor: PlateEditor;
	initialMarkdown: string;
	filePath?: string | null;
	readOnly?: boolean;
	onPersist?: (
		path: string,
		markdown: string,
		lastSaved: string,
	) => Promise<boolean>;
	onDirtyChange?: (dirty: boolean) => void;
	/** Another panel saved over this draft. Autosave must not replace that file. */
	saveBlocked?: boolean;
	/**
	 * Mirrored props owned by the caller: the Plate plugin store is built before
	 * this hook runs, so both it and autosave read the same cells.
	 */
	filePathRef: RefObject<string | null>;
	onAssetsChangedRef: RefObject<(() => void) | undefined>;
};

export type MarkdownPersistence = {
	/** YAML interior for the Properties panel (no `---` fences). */
	frontmatterYaml: string;
	onFrontmatterChange: (interior: string) => void;
	/** The whole document as Markdown, frontmatter re-attached. */
	serialize: () => string;
	/** Debounced autosave; also reconciles `./assets/` when the debounce fires. */
	noteDocumentChanged: () => void;
	/**
	 * Flush the pending debounce and write immediately. `force` writes once past
	 * a sibling-panel `saveBlocked` hold; the permission dies with this call, so
	 * it cannot leak into a later autosave.
	 */
	saveNow: (force?: boolean) => Promise<boolean>;
	beginSource: (markdown: string) => void;
	updateSource: (read: () => string) => void;
	endSource: (
		value: PlateEditor["children"] | null,
		frontmatter: string,
	) => void;
	/** Source mode or a raw source snapshot waiting to be persisted. */
	hasSourceSnapshot: () => boolean;
	/**
	 * Reload the document in place after an external/Agent disk write or a
	 * sibling pane's save. Reuses proven-equal top-level blocks so unchanged
	 * regions keep their DOM; does not mark dirty or trigger autosave.
	 * Returns false when the content matches the current disk snapshot
	 * (own-write echo) and nothing was reloaded.
	 */
	applyExternalMarkdown: (markdown: string) => boolean;
	/**
	 * Treat `markdown` as the current disk bytes without replacing the editor.
	 * The next save then writes this draft over that version on purpose.
	 */
	adoptDiskBaseline: (markdown: string) => void;
	/** Content currently believed to be on disk. */
	savedRef: RefObject<string>;
	dirtyRef: RefObject<boolean>;
};

/**
 * Autosave, dirty tracking and managed `./assets/` GC for one open file.
 *
 * The debounce, the in-flight/queued pair and the unmount flush exist so a fast
 * file switch still lands the last edit on the file it was typed into.
 */
export function useMarkdownPersistence({
	editor,
	initialMarkdown,
	filePath,
	readOnly,
	onPersist,
	onDirtyChange,
	saveBlocked = false,
	filePathRef,
	onAssetsChangedRef,
}: UseMarkdownPersistenceOptions): MarkdownPersistence {
	const frontmatterRef = useRef("");
	const [frontmatterYaml, setFrontmatterYaml] = useState(() => {
		const { frontmatter } = splitFrontmatter(initialMarkdown);
		// Seed ref before first serialize / persist can run.
		frontmatterRef.current = frontmatter;
		return frontmatterInterior(frontmatter);
	});
	const savedRef = useRef(initialMarkdown);
	// A source edit retains CodeMirror's immutable doc until the save reads it.
	// After switching back, keep that exact text until the first rich edit.
	const sourceRef = useRef<(() => string) | null>(null);
	const projectedSourceRef = useRef<string | null>(null);
	const readyRef = useRef(false);
	const unmountedRef = useRef(false);
	const detachedNativeDraftRef = useRef<string | undefined>(undefined);
	/**
	 * Tracks the dirty flag so `onDirtyChange` fires only on a real transition.
	 * Without this, every keystroke would call it and re-render the whole app
	 * (the tab-bar unsaved indicator), which made editing laggy on large notes.
	 */
	const dirtyRef = useRef(false);
	const saveBlockedRef = useRef(saveBlocked);
	saveBlockedRef.current = saveBlocked;
	/** One explicit "keep draft" save, past the hold that the prop still shows. */
	const allowBlockedSaveRef = useRef(false);
	const persistInFlightRef = useRef<Promise<void> | null>(null);
	const persistQueuedRef = useRef(false);
	/**
	 * True while `applyExternalMarkdown` replaces the document: the resulting
	 * editor change is disk content, not a user edit, so it must not mark the
	 * document dirty or schedule autosave.
	 */
	const externalReloadRef = useRef(false);
	/** Bumped by external reloads so an in-flight persist cannot settle stale state. */
	const reloadGenerationRef = useRef(0);
	/** Image URL ref-counts; used to GC `./assets/` when an image node is removed. */
	const imageCountsRef = useRef<Map<string, number> | null>(null);
	/** The path whose latest canonical write confirmed the current ref counts. */
	const assetSaveConfirmedRef = useRef<string | null>(null);
	const assetOwnerPathRef = useRef(filePath);
	assetOwnerPathRef.current = filePath;
	const reconcileAssetsRef = useRef<() => void>(() => {});
	/**
	 * Debounced asset GC so cut → paste / undo still finds the file.
	 * Immediate delete used to leave a live `./assets/…` node with a missing file.
	 */
	const assetGcRef = useRef(
		createManagedAssetGc({
			canDelete: (path) =>
				path === assetOwnerPathRef.current &&
				assetSaveConfirmedRef.current === path &&
				!dirtyRef.current &&
				!saveBlockedRef.current &&
				!externalReloadRef.current &&
				!persistInFlightRef.current,
			onDeleted: () => {
				onAssetsChangedRef.current?.();
			},
		}),
	);

	const serialize = useCallback(() => {
		if (sourceRef.current) return sourceRef.current();
		if (projectedSourceRef.current !== null) return projectedSourceRef.current;
		const body = stripInlinePlaceholders(
			editor.getApi(MarkdownPlugin).markdown.serialize(),
		);
		const frontmatter = frontmatterRef.current;
		return joinFrontmatter(
			frontmatter && body && !frontmatter.endsWith("\n")
				? `${frontmatter}\n`
				: frontmatter,
			body,
		);
	}, [editor]);

	const setDirty = useCallback(
		(dirty: boolean) => {
			if (dirty) assetSaveConfirmedRef.current = null;
			if (dirtyRef.current === dirty) return;
			dirtyRef.current = dirty;
			onDirtyChange?.(dirty);
		},
		[onDirtyChange],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: editor.children is an identity probe; depending on it would rebuild persist per keystroke
	const persist = useCallback(() => {
		// Consume the "keep draft" permission before any early return: a leaked
		// true would let the next autosave bypass the sibling-panel hold.
		const forced = allowBlockedSaveRef.current;
		allowBlockedSaveRef.current = false;
		if (readOnly || !filePath || !onPersist) return Promise.resolve();
		if (saveBlockedRef.current && !forced) {
			persistQueuedRef.current = false;
			return Promise.resolve();
		}
		persistQueuedRef.current = true;
		if (persistInFlightRef.current) return persistInFlightRef.current;

		const task = (async () => {
			while (persistQueuedRef.current) {
				persistQueuedRef.current = false;
				const markdown = serialize();
				// Snapshot both serialize() inputs. Slate replaces `children` on
				// every edit and frontmatter edits swap the ref, so reference
				// equality tells us whether the document moved during the write
				// without paying a second full-document serialization per save.
				const childrenSnapshot = editor.children;
				const frontmatterSnapshot = frontmatterRef.current;
				const sourceSnapshot = sourceRef.current;
				const projectedSnapshot = projectedSourceRef.current;
				const lastSaved = savedRef.current;
				if (markdown === lastSaved) {
					setDirty(false);
					continue;
				}
				if (
					sourceSnapshot === null &&
					projectedSnapshot === null &&
					!markdown.trim() &&
					lastSaved.trim()
				)
					return;

				const generation = reloadGenerationRef.current;
				assetSaveConfirmedRef.current = null;
				let persisted = false;
				try {
					persisted = await onPersist(filePath, markdown, lastSaved);
				} catch {
					// The App owns user-facing persistence errors. Keep this editor
					// dirty and retain the last disk-confirmed snapshot.
				}
				// An external reload replaced the document while this write was in
				// flight; its snapshot is authoritative, do not settle over it.
				if (generation !== reloadGenerationRef.current) return;
				if (
					unmountedRef.current &&
					detachedNativeDraftRef.current !== undefined
				) {
					persistQueuedRef.current = false;
					// Only confirmed bytes may advance this detached working copy.
					// Compare its captured final draft without reading destroyed Plate.
					if (persisted) {
						savedRef.current = markdown;
						setDirty(detachedNativeDraftRef.current !== markdown);
						assetSaveConfirmedRef.current = dirtyRef.current ? null : filePath;
					}
					return;
				}
				const settlement = settleMarkdownSaveAttempt({
					attemptedMarkdown: markdown,
					currentMarkdown:
						editor.children === childrenSnapshot &&
						frontmatterRef.current === frontmatterSnapshot &&
						sourceRef.current === sourceSnapshot &&
						projectedSourceRef.current === projectedSnapshot
							? markdown
							: serialize(),
					lastSaved,
					persisted,
				});
				savedRef.current = settlement.savedMarkdown;
				setDirty(settlement.dirty);
				if (persisted && !settlement.dirty && !unmountedRef.current) {
					// Undo/paste may have revived an image while IO was pending.
					// Reconcile the confirmed snapshot before permitting any deletion.
					reconcileAssetsRef.current();
					assetSaveConfirmedRef.current = filePath;
				}
				if (!persisted) {
					persistQueuedRef.current = false;
					return;
				}
				if (settlement.retryLatest) persistQueuedRef.current = true;
			}
		})();
		persistInFlightRef.current = task;
		const finish = () => {
			if (persistInFlightRef.current === task) {
				persistInFlightRef.current = null;
				if (persistQueuedRef.current) persistRef.current();
				else if (assetSaveConfirmedRef.current) {
					if (unmountedRef.current) void assetGcRef.current.flush();
					else assetGcRef.current.resume();
				}
			}
		};
		void task.then(finish, finish);
		return task;
	}, [filePath, onPersist, readOnly, serialize, setDirty]);

	// Latest persist closure, for the unmount flush (captures this file's path).
	const persistRef = useRef(persist);
	persistRef.current = persist;
	const teardownRef = useRef({ filePath, readOnly, onPersist, serialize });
	teardownRef.current = { filePath, readOnly, onPersist, serialize };

	/**
	 * Diff `./assets/` ref-counts and hand the delta to the GC.
	 *
	 * `collectImageUrlCounts` walks every node, so this runs once per debounce
	 * window rather than per keystroke. The GC is itself debounced, so deferring
	 * the diff does not change when files actually get deleted.
	 */
	const reconcileAssets = useCallback(() => {
		if (sourceRef.current) return;
		const nextCounts = collectImageUrlCounts(editor.children);
		const prevCounts = imageCountsRef.current;
		imageCountsRef.current = nextCounts;
		const mdPath = filePathRef.current;
		// Skip bookkeeping for image-free notes — the common case.
		if (mdPath && prevCounts && (prevCounts.size || nextCounts.size)) {
			assetGcRef.current.observe(mdPath, prevCounts, nextCounts);
		}
	}, [editor, filePathRef]);
	reconcileAssetsRef.current = reconcileAssets;

	/** Debounced autosave; flushed on unmount, cancelled by external reloads. */
	const debouncedPersist = useDebouncedCallback(() => {
		reconcileAssetsRef.current();
		persistRef.current();
	}, CHANGE_DEBOUNCE_MS);

	useEffect(() => {
		if (!saveBlocked) {
			assetGcRef.current.resume();
			return;
		}
		assetSaveConfirmedRef.current = null;
		debouncedPersist.cancel();
		persistQueuedRef.current = false;
	}, [saveBlocked, debouncedPersist]);

	// Mark ready after the initial normalization pass so opening a file never saves.
	// Seed image URL counts so we only GC assets removed after open.
	// On unmount, flush pending edit + deferred asset GC for this file.
	useEffect(() => {
		readyRef.current = true;
		unmountedRef.current = false;
		detachedNativeDraftRef.current = undefined;
		// Seeding the count walks the whole tree; defer it so it never competes
		// with the first paint. Until it lands, `reconcileAssets` skips the GC
		// diff (prev counts null), so nothing can be deleted by mistake.
		const cancelSeed = scheduleIdle(() => {
			imageCountsRef.current = collectImageUrlCounts(editor.children);
		});
		const assetGc = assetGcRef.current;
		return () => {
			cancelSeed();
			reconcileAssetsRef.current();
			if (
				dirtyRef.current ||
				persistInFlightRef.current ||
				saveBlockedRef.current
			)
				assetSaveConfirmedRef.current = null;
			unmountedRef.current = true;
			const final = teardownRef.current;
			// Capture before the source/Plate document is destroyed. A rejected
			// in-flight save can otherwise drop a newer queued source edit on close.
			const rescueLocalDraft = Boolean(
				isTauri() &&
					final.filePath &&
					!parseRemoteJoinedPath(final.filePath) &&
					!final.readOnly &&
					final.onPersist &&
					dirtyRef.current,
			);
			const markdown = rescueLocalDraft ? final.serialize() : undefined;
			const generation = reloadGenerationRef.current;
			const expectedOnClose = savedRef.current;
			const incompleteRichEmpty =
				sourceRef.current === null &&
				projectedSourceRef.current === null &&
				markdown !== undefined &&
				!markdown.trim() &&
				Boolean(savedRef.current.trim());
			detachedNativeDraftRef.current = incompleteRichEmpty
				? undefined
				: markdown;
			debouncedPersist.flush();
			if (markdown !== undefined && !incompleteRichEmpty && final.filePath) {
				const path = final.filePath;
				void (async () => {
					try {
						await persistInFlightRef.current;
					} catch {
						/* Rescue the immutable final draft after a failed callback. */
					}
					if (
						generation !== reloadGenerationRef.current ||
						markdown === savedRef.current
					)
						return;
					// The native guard either publishes against this confirmed base or
					// preserves exact bytes as a .md conflict; it cannot replace sync data.
					const retry = () =>
						writeVaultFile(path, markdown, {
							expectedContent: expectedOnClose,
						});
					const report = (error: unknown) =>
						notifyError(errorText(error), {
							id: `markdown-final:${path}`,
							action: isPreservedVaultWriteConflict(error)
								? undefined
								: {
										label: i18n.t("viewer:pdf.bookmarks.retry"),
										onClick: () => {
											void retry().catch(report);
										},
									},
						});
					await retry().catch(report);
				})();
			}
			// flush retains queued files while canonical text is unconfirmed.
			void assetGc.flush();
		};
	}, [editor, debouncedPersist]);

	const schedulePersist = useCallback(() => {
		if (readOnly || !readyRef.current || externalReloadRef.current) return;
		if (!dirtyRef.current) {
			setDirty(true);
		}
		if (saveBlockedRef.current) return;
		debouncedPersist();
	}, [readOnly, setDirty, debouncedPersist]);

	/** Install a parsed projection without treating it as a user edit. */
	const replaceProjection = useCallback(
		(value: PlateEditor["children"], frontmatter: string) => {
			externalReloadRef.current = true;
			try {
				editor.tf.withoutSaving(() => {
					editor.tf.deselect();
					// Reuse proven-equal top-level blocks: wholesale `setValue`
					// hands slate-react all-new node objects, so every block
					// remounts and the pane flickers/jumps on each sibling-pane
					// save echo or streamed external write.
					applySourceProjection(editor, value);
				});
				editor.history = { undos: [], redos: [] };
				frontmatterRef.current = frontmatter;
				setFrontmatterYaml(frontmatterInterior(frontmatter));
				imageCountsRef.current = collectImageUrlCounts(editor.children);
			} finally {
				// Slate's onChange is queued as a microtask by setValue.
				queueMicrotask(() => {
					externalReloadRef.current = false;
				});
			}
		},
		[editor],
	);

	const beginSource = useCallback((markdown: string) => {
		sourceRef.current = () => markdown;
		assetGcRef.current.cancelAll();
	}, []);

	const updateSource = useCallback(
		(read: () => string) => {
			if (!sourceRef.current) return;
			sourceRef.current = read;
			schedulePersist();
		},
		[schedulePersist],
	);

	const endSource = useCallback(
		(value: PlateEditor["children"] | null, frontmatter: string) => {
			if (!sourceRef.current) return;
			const raw = sourceRef.current();
			if (value) replaceProjection(value, frontmatter);
			else editor.history = { undos: [], redos: [] };
			projectedSourceRef.current = raw;
			sourceRef.current = null;
		},
		[editor, replaceProjection],
	);

	const noteDocumentChanged = useCallback(() => {
		if (sourceRef.current || externalReloadRef.current || !readyRef.current)
			return;
		projectedSourceRef.current = null;
		schedulePersist();
	}, [schedulePersist]);

	const hasSourceSnapshot = useCallback(
		() => sourceRef.current !== null || projectedSourceRef.current !== null,
		[],
	);

	const applyExternalMarkdown = useCallback(
		(markdown: string) => {
			// Own-write echo (autosave advanced the seed): nothing to reload.
			if (markdown === savedRef.current && !dirtyRef.current) return false;
			assetSaveConfirmedRef.current = null;
			assetGcRef.current.cancelAll();
			reloadGenerationRef.current += 1;
			persistQueuedRef.current = false;
			debouncedPersist.cancel();
			projectedSourceRef.current = null;
			if (sourceRef.current) {
				sourceRef.current = () => markdown;
			} else {
				const { frontmatter, body } = splitFrontmatter(markdown);
				replaceProjection(deserializeMarkdownBody(editor, body), frontmatter);
			}
			savedRef.current = markdown;
			setDirty(false);
			return true;
		},
		[editor, setDirty, debouncedPersist, replaceProjection],
	);

	const onFrontmatterChange = useCallback(
		(interior: string) => {
			setFrontmatterYaml(interior);
			frontmatterRef.current = wrapFrontmatter(interior);
			noteDocumentChanged();
		},
		[noteDocumentChanged],
	);

	const adoptDiskBaseline = useCallback(
		(markdown: string) => {
			savedRef.current = markdown;
			setDirty(serialize() !== markdown);
		},
		[serialize, setDirty],
	);

	const saveNow = useCallback(
		async (force?: boolean) => {
			debouncedPersist.cancel();
			reconcileAssetsRef.current();
			if (force) allowBlockedSaveRef.current = true;
			try {
				await persistRef.current();
			} finally {
				// Clear even when persist bailed out before consuming it (read-only or
				// no file path): the permission must not outlive this explicit save.
				allowBlockedSaveRef.current = false;
			}
			return !dirtyRef.current;
		},
		[debouncedPersist],
	);

	return {
		frontmatterYaml,
		onFrontmatterChange,
		serialize,
		noteDocumentChanged,
		beginSource,
		updateSource,
		endSource,
		hasSourceSnapshot,
		saveNow,
		applyExternalMarkdown,
		adoptDiskBaseline,
		savedRef,
		dirtyRef,
	};
}
