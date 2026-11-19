/**
 * Highlights (划词高亮/批注) for the EmbedPDF viewer. Highlights are *not* an
 * app-side overlay: they are real PDF annotations owned by EmbedPDF's annotation
 * plugin and persisted to `marks/annotations.json`, so this cluster is the whole
 * bridge between that plugin scope and the React tree.
 *
 * It owns three derived states that share exactly one writer — `rebuildHighlights`,
 * which runs once per coalesced annotation-event burst (a batch import emits
 * one event per annotation):
 * - `highlights`: the view models published to the annotations panel;
 * - `highlightAnchors`: normalized 0–1 rects for gutter-pin placement, computed
 *   here (where the raw objects and page sizes are already in hand) so pin
 *   geometry never reads plugin state during render;
 * - `citationLinks`: the per-page link map, a by-product of the same walk over
 *   the tracked annotation list (consumed by {@link usePdfCitations}).
 *
 * Its own hook because plugin ownership is the boundary: import/migrate-on-open,
 * the event subscription and the debounced export are one lifecycle, while every
 * reader (page layers, pins, annotations panel, imperative handle) only needs the
 * resulting arrays.
 */

import { useCapability } from "@embedpdf/core/react";
import type {
	PdfHighlightAnnoObject,
	PdfLinkAnnoObject,
	PdfUnderlineAnnoObject,
} from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import { type LockMode, LockModeType } from "@embedpdf/plugin-annotation";
import type {
	AnnotationEvent,
	AnnotationTransferItem,
	useAnnotationCapability,
} from "@embedpdf/plugin-annotation/react";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isLinkObject } from "@/components/viewer/pdf/layers/citation-links";
import type { PdfViewerProps } from "@/components/viewer/pdf/types";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { planAnnotationItemImport } from "@/lib/pdf/highlight/annotation-items";
import {
	ANNOTATIONS_FILE,
	type AnnotationFileBase,
	type HighlightCustom,
	hasAnnotationsFile,
	highlightViewFromObject,
	isLiveAnnotation,
	isPreservedAnnotationConflict,
	isTextMarkupObject,
	loadAnnotationItems,
	readAnnotationFileContent,
	saveAnnotationItems,
	saveAnnotationSnapshot,
} from "@/lib/pdf/highlight/annotation-store";
import {
	advanceAnnotationPeerBaseline,
	applyAnnotationMutation,
	enqueueAnnotationSave,
	invalidateAnnotationPeers,
	publishAnnotationMutation,
	subscribeAnnotationPeer,
} from "@/lib/pdf/highlight/annotation-sync";
import { createAnnotationDeleteQueue } from "@/lib/pdf/highlight/delete-queue";
import {
	createAnnotationHistoryReplay,
	type PdfHistoryPlugin,
} from "@/lib/pdf/highlight/history";
import { migrateHighlightMarks } from "@/lib/pdf/highlight/migrate-marks";
import {
	HIGHLIGHT_HEX,
	HIGHLIGHT_OPACITY,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import type {
	PdfHighlight,
	PdfTextMarkupKind,
} from "@/lib/pdf/highlight/types";
import type { VisibleSelectionPage } from "@/lib/pdf/layout/visible-selection-rects";
import type { NormalizedRect } from "@/lib/pdf/selection";
import { marksDir } from "@/lib/pdf/selection";
import { isRecentSelfWrite } from "@/lib/pdf/selection/marks-io";
import { listenVaultFileChangedGated } from "@/lib/vault/file-change-gate";
import { joinVaultPath, normalizePathKey } from "@/lib/vault/path";

/** Coalesce annotation bursts (drag-create, multi-page highlight) into one export. */
const HIGHLIGHT_SAVE_DEBOUNCE_MS = 600;

/** One CLI invocation can append several highlights; coalesce the watcher burst. */
const ANNOTATIONS_REIMPORT_BURST_MS = 200;

type AnnotationCapabilityProvides = ReturnType<
	typeof useAnnotationCapability
>["provides"];

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

export type UsePdfHighlightsOptions = {
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	annotationCap: AnnotationCapabilityProvides;
	/** EmbedPDF capability; returns a fresh scope each render, so never a dep. */
	docCap: DocumentManagerCapability;
	docId: string;
	/** Sidecar location for `marks/annotations.json` (null for loose PDFs). */
	paperAbsPath: string | null;
	/** Stable paper key stamped onto the published highlight view models. */
	paperKey: string | null;
	/** Import waits for the document, which is what makes the page count > 0. */
	totalPages: number;
	/** Prop-latest ref so publishing never re-fires on parent re-render. */
	onHighlightsChangeRef: RefObject<PdfViewerProps["onHighlightsChange"]>;
	/** Remount only this PDF after its exact pending export has been preserved. */
	onReloadAnnotations?: () => void;
};

export type PdfHighlights = {
	runAnnotationBatch: (action: () => void) => void;
	replayAnnotationHistory: (redo: boolean) => void;
	highlights: PdfHighlight[];
	/** Mirror for the imperative handle (must not re-register per change). */
	highlightsRef: RefObject<PdfHighlight[]>;
	/** Annotation id → normalized rect, for gutter-pin placement. */
	highlightAnchors: Map<string, NormalizedRect>;
	/** 0-based page index → in-text link annotations with a target. */
	citationLinks: Map<number, PdfLinkAnnoObject[]>;
	/** Re-read the plugin scope; also the annotation-event handler. */
	rebuildHighlights: () => void;
	/** Create one text-markup annotation per selected page span; returns the new ids. */
	createHighlights: (
		pages: FormattedSelection[],
		color: HighlightColor,
		quote: string,
		/**
		 * Translated selection, in page fractions. Stored beside the English
		 * glyph boxes and painted only while the translation overlay is on.
		 */
		translatedPages?: readonly VisibleSelectionPage[],
		/** Markup shape; defaults to a highlight. */
		shape?: PdfTextMarkupKind,
	) => { pageIndex: number; id: string }[];
	/** Write a 批注 comment onto an existing highlight (empty clears it). */
	updateHighlightComment: (
		pageIndex: number,
		id: string,
		comment: string,
	) => void;
	/** Change the color of an existing highlight annotation. */
	updateHighlightColor: (
		pageIndex: number,
		id: string,
		color: HighlightColor,
	) => void;
	deleteHighlightAnnotation: (pageIndex: number, id: string) => void;
};

export function usePdfHighlights({
	annotationCap,
	docCap,
	docId,
	paperAbsPath,
	paperKey,
	totalPages,
	onHighlightsChangeRef,
	onReloadAnnotations,
}: UsePdfHighlightsOptions): PdfHighlights {
	const { provides: historyCap } = useCapability<PdfHistoryPlugin>("history");
	const history = historyCap?.forDocument(docId);
	const historyReplayRef = useRef<ReturnType<
		typeof createAnnotationHistoryReplay
	> | null>(null);
	const runAnnotationBatch = useCallback(
		(action: () => void) => {
			if (history) history.batch(action);
			else action();
		},
		[history],
	);
	const replayAnnotationHistory = useCallback((redo: boolean) => {
		void historyReplayRef.current?.replay(redo);
	}, []);
	const [highlights, setHighlights] = useState<PdfHighlight[]>([]);
	/** Normalized annotation rects for pin placement, keyed by annotation id. */
	const [highlightAnchors, setHighlightAnchors] = useState(
		() => new Map<string, NormalizedRect>(),
	);
	const [citationLinks, setCitationLinks] = useState<
		Map<number, PdfLinkAnnoObject[]>
	>(new Map());
	const highlightsRef = useRef(highlights);
	highlightsRef.current = highlights;
	// Each mounted viewer owns its base. Watcher/annotation-ref reads must not
	// silently rebase this working copy over sync updates or remote deletions.
	const annotationBase = useMemo<AnnotationFileBase>(
		() => ({
			path: paperAbsPath
				? joinVaultPath(marksDir(paperAbsPath), ANNOTATIONS_FILE)
				: undefined,
		}),
		[paperAbsPath],
	);
	const importedRef = useRef(false);
	const importingRef = useRef(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const deleteQueueRef = useRef<ReturnType<
		typeof createAnnotationDeleteQueue
	> | null>(null);
	const reloadRequiredRef = useRef(false);
	const reloadPendingRef = useRef(false);
	const saveEpochRef = useRef(0);
	const pendingSaveCountRef = useRef(0);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const initialImportDoneRef = useRef(false);
	const initialLockRef = useRef<LockMode>({ type: LockModeType.None });
	const initialLockCapturedRef = useRef(false);
	useLayoutEffect(() => {
		const scope = annotationCap?.forDocument(docId);
		if (!scope || initialImportDoneRef.current) return;
		if (!initialLockCapturedRef.current) {
			initialLockCapturedRef.current = true;
			initialLockRef.current = scope.getState().locked ?? {
				type: LockModeType.None,
			};
		}
		scope.setLocked({ type: LockModeType.All });
	}, [annotationCap, docId]);
	const applyPeerEvent = useCallback(
		(event: Exclude<AnnotationEvent, { type: "loaded" }>) => {
			if (reloadRequiredRef.current) return;
			if (!initialImportDoneRef.current) {
				// Buffer early peer edits until this pane's canonical import lands,
				// so a simultaneous split/translation view mirrors them on replay.
				pendingPeerEventsRef.current.push(event);
				return;
			}
			const scope = annotationCap?.forDocument(docId);
			if (!scope) return;
			const wasImporting = importingRef.current;
			importingRef.current = true;
			try {
				history?.invalidate([event.annotation.id]);
				const apply = () => {
					if (event.type === "delete" && deleteQueueRef.current) {
						const tracked = scope.getAnnotationById(event.annotation.id);
						if (tracked && isLiveAnnotation(tracked))
							deleteQueueRef.current.delete(
								event.pageIndex,
								event.annotation.id,
							);
					} else applyAnnotationMutation(scope, event);
				};
				if (history) history.withoutRecording(apply);
				else apply();
				scope.commit();
			} catch (error) {
				notifyError(errorText(error));
			} finally {
				importingRef.current = wasImporting;
			}
		},
		[annotationCap, docId, history],
	);
	const pendingPeerEventsRef = useRef<
		Exclude<AnnotationEvent, { type: "loaded" }>[]
	>([]);
	const peerSubscriptionRef = useRef<(() => void) | null>(null);
	// Subscribe as soon as the pane mounts so a simultaneous peer's early edits
	// are received (and buffered until import) instead of being lost before the
	// canonical post-import re-subscribe. The post-import subscribe re-binds with
	// the authoritative baseline for epoch invalidation.
	useEffect(() => {
		if (!paperAbsPath || !annotationCap) return;
		peerSubscriptionRef.current?.();
		peerSubscriptionRef.current = subscribeAnnotationPeer(
			paperAbsPath,
			docId,
			applyPeerEvent,
		);
		return () => {
			peerSubscriptionRef.current?.();
			peerSubscriptionRef.current = null;
		};
	}, [paperAbsPath, docId, annotationCap, applyPeerEvent]);

	const rebuildHighlights = useCallback(() => {
		if (!annotationCap) return;
		const scope = annotationCap.forDocument(docId);
		// Deleted annotations stay in the plugin's tracked list until an async
		// commit purges them (and a dropped commit can leave them there for the
		// session). They must not reach the rail, pins or paint layers.
		const all = scope.getAnnotations().filter(isLiveAnnotation);
		const doc = docCap?.getDocument(docId);
		const objects = all.map((a) => a.object).filter(isTextMarkupObject);
		const list = objects.map((o) => {
			const view = highlightViewFromObject(o, paperKey ?? "");
			const size = doc?.pages[o.pageIndex]?.size;
			if (size?.width && size?.height) {
				const pw = size.width;
				const ph = size.height;
				const sourceRects = o.segmentRects?.length ? o.segmentRects : [o.rect];
				view.rects = sourceRects.map((r) => ({
					x: r.origin.x / pw,
					y: r.origin.y / ph,
					w: r.size.width / pw,
					h: r.size.height / ph,
				}));
			}
			return view;
		});
		setHighlights(list);
		onHighlightsChangeRef.current?.(list);
		// Pin anchors: normalize each annotation rect here, where the objects are
		// already in hand, so pin geometry never reads plugin state during render.
		const anchors = new Map<string, NormalizedRect>();
		for (const o of objects) {
			const size = doc?.pages[o.pageIndex]?.size;
			if (!size?.width || !size?.height) continue;
			anchors.set(o.id, {
				x: o.rect.origin.x / size.width,
				y: o.rect.origin.y / size.height,
				w: o.rect.size.width / size.width,
				h: o.rect.size.height / size.height,
			});
		}
		setHighlightAnchors(anchors);
		const links = new Map<number, PdfLinkAnnoObject[]>();
		for (const tracked of all) {
			const o = tracked.object;
			if (isLinkObject(o) && o.target) {
				const arr = links.get(o.pageIndex);
				if (arr) arr.push(o);
				else links.set(o.pageIndex, [o]);
			}
		}
		// The link set only changes when a link annotation is added / removed /
		// retargeted — saving a comment or recoloring a highlight leaves it
		// identical. Keep the previous map reference then, so the pages' link
		// layers don't re-render (elements are the plugin's tracked annotation
		// objects, so identity per element is the equality that matters).
		setCitationLinks((prev) => {
			if (prev.size === links.size) {
				let unchanged = true;
				for (const [page, next] of links) {
					const old = prev.get(page);
					if (
						!old ||
						old.length !== next.length ||
						next.some((link, i) => link !== old[i])
					) {
						unchanged = false;
						break;
					}
				}
				if (unchanged) return prev;
			}
			return links;
		});
	}, [annotationCap, docCap, docId, paperKey, onHighlightsChangeRef]);

	// A batch import emits one event per annotation within a single task;
	// coalesce the burst into one rebuild (n events → O(n²) full walks → O(n)).
	const rebuildPendingRef = useRef(false);
	const scheduleRebuild = useCallback(() => {
		if (rebuildPendingRef.current) return;
		rebuildPendingRef.current = true;
		queueMicrotask(() => {
			rebuildPendingRef.current = false;
			rebuildHighlights();
		});
	}, [rebuildHighlights]);

	const freezeForReload = useCallback(() => {
		if (!reloadRequiredRef.current) {
			reloadRequiredRef.current = true;
			saveEpochRef.current += 1;
		}
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = null;
		const scope = annotationCap?.forDocument(docId);
		scope?.setActiveTool(null);
		scope?.setLocked({ type: LockModeType.All });
	}, [annotationCap, docId]);

	const offerReload = useCallback(
		(error: unknown) => {
			if (!mountedRef.current) return;
			freezeForReload();
			const show = (failure: unknown) => {
				notifyError(errorText(failure), {
					id: `annotation-reload:${docId}`,
					action:
						onReloadAnnotations && paperAbsPath && annotationCap
							? {
									label: i18n.t("app:diskConflict.reload"),
									onClick: () => {
										if (!mountedRef.current || reloadPendingRef.current) return;
										reloadPendingRef.current = true;
										// Old queued exports are retired by freezeForReload's epoch.
										// Capture again here to preserve the latest state before remount.
										void enqueueAnnotationSave(paperAbsPath, async () => {
											if (!mountedRef.current) return;
											if (annotationBase.content !== undefined) {
												try {
													await saveAnnotationSnapshot(
														paperAbsPath,
														() =>
															annotationCap
																.forDocument(docId)
																.exportAnnotations()
																.toPromise(),
														{ ...annotationBase },
													);
												} catch (saveError) {
													if (!isPreservedAnnotationConflict(saveError))
														throw saveError;
												}
											}
											const raw = await readAnnotationFileContent(paperAbsPath);
											invalidateAnnotationPeers(paperAbsPath, raw);
											if (mountedRef.current) onReloadAnnotations();
										})
											.catch(show)
											.finally(() => {
												reloadPendingRef.current = false;
											});
									},
								}
							: undefined,
				});
			};
			show(error);
		},
		[
			annotationBase,
			annotationCap,
			docId,
			freezeForReload,
			onReloadAnnotations,
			paperAbsPath,
		],
	);

	const persistAnnotations = useCallback(
		(beforeUnmount = false) => {
			if (
				!paperAbsPath ||
				!annotationCap ||
				(reloadRequiredRef.current && !beforeUnmount)
			)
				return;
			if (beforeUnmount && annotationBase.content === undefined) return;
			const epoch = saveEpochRef.current;
			// Normal exports are captured inside the queue. An unmount must capture
			// while its engine still exists; freeze its old base alongside the export
			// so that an older queued snapshot can never borrow a newer expected base.
			const base = beforeUnmount ? { ...annotationBase } : annotationBase;
			const finalSnapshot = beforeUnmount
				? annotationCap.forDocument(docId).exportAnnotations().toPromise()
				: null;
			// Observe a rejected teardown export immediately while its queue slot waits.
			if (finalSnapshot) void finalSnapshot.catch(() => {});
			pendingSaveCountRef.current += 1;
			void enqueueAnnotationSave(paperAbsPath, async () => {
				const previous = base.content;
				await saveAnnotationSnapshot(
					paperAbsPath,
					() =>
						finalSnapshot ??
						annotationCap.forDocument(docId).exportAnnotations().toPromise(),
					base,
					() => epoch === saveEpochRef.current,
				);
				if (epoch === saveEpochRef.current)
					advanceAnnotationPeerBaseline(
						paperAbsPath,
						docId,
						previous,
						base.content,
					);
			})
				.catch((error) => {
					if (!beforeUnmount) {
						offerReload(error);
						return;
					}
					// The viewer may already be gone. Surface the final failure
					// globally and retain its immutable export/base in the retry action.
					const reportFinal = (failure: unknown) =>
						notifyError(errorText(failure), {
							id: `annotation-final:${docId}`,
							action:
								finalSnapshot && !isPreservedAnnotationConflict(failure)
									? {
											label: i18n.t("viewer:pdf.bookmarks.retry"),
											onClick: () => {
												void enqueueAnnotationSave(paperAbsPath, () =>
													saveAnnotationSnapshot(
														paperAbsPath,
														() => finalSnapshot,
														{ ...base },
													),
												).catch(reportFinal);
											},
										}
									: undefined,
						});
					reportFinal(error);
				})
				.finally(() => {
					pendingSaveCountRef.current -= 1;
				});
		},
		[paperAbsPath, annotationCap, docId, annotationBase, offerReload],
	);

	/** Deletions bypass the normal debounce. */
	const scheduleSave = useCallback(
		(immediate = false) => {
			if (!paperAbsPath || !annotationCap || reloadRequiredRef.current) return;
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(
				() => {
					saveTimerRef.current = null;
					persistAnnotations();
				},
				immediate ? 0 : HIGHLIGHT_SAVE_DEBOUNCE_MS,
			);
		},
		[paperAbsPath, annotationCap, persistAnnotations],
	);
	useLayoutEffect(
		() => () => {
			if (
				!saveTimerRef.current &&
				pendingSaveCountRef.current === 0 &&
				!reloadRequiredRef.current
			)
				return;
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
			// Retire normal exports still queued behind another viewer's save,
			// then capture the final state before this document is destroyed.
			saveEpochRef.current += 1;
			persistAnnotations(true);
		},
		[persistAnnotations],
	);

	useEffect(() => {
		if (!annotationCap) return;
		const scope = annotationCap.forDocument(docId);
		const off = scope.onAnnotationEvent((event) => {
			scheduleRebuild();
			if (
				event.type !== "loaded" &&
				!reloadRequiredRef.current &&
				initialImportDoneRef.current &&
				!event.committed &&
				!importingRef.current
			) {
				if (paperAbsPath) publishAnnotationMutation(paperAbsPath, event);
				scheduleSave(event.type === "delete");
			}
		});
		rebuildHighlights();
		return () => off();
	}, [
		annotationCap,
		docId,
		paperAbsPath,
		rebuildHighlights,
		scheduleRebuild,
		scheduleSave,
	]);

	useEffect(() => {
		if (importedRef.current || !annotationCap || !docCap || totalPages <= 0)
			return;
		importedRef.current = true;
		let cancelled = false;
		void (async () => {
			const scope = annotationCap.forDocument(docId);
			const loadingBase: AnnotationFileBase = {};
			let items: AnnotationTransferItem[] = paperAbsPath
				? await loadAnnotationItems(paperAbsPath, loadingBase)
				: [];
			if (cancelled) return;
			Object.assign(annotationBase, loadingBase);
			if (
				paperAbsPath &&
				!items.length &&
				!(await hasAnnotationsFile(paperAbsPath))
			) {
				const doc = docCap.getDocument(docId);
				const migrated = await migrateHighlightMarks(
					paperAbsPath,
					(pageIndex) => doc?.pages[pageIndex]?.size ?? null,
				);
				if (migrated.length) {
					items = migrated;
					await saveAnnotationItems(paperAbsPath, migrated, annotationBase);
				}
			}
			if (cancelled) return;
			if (items.length) {
				importingRef.current = true;
				const plan = planAnnotationItemImport(
					items,
					scope
						.getAnnotations()
						.filter(isLiveAnnotation)
						.map((item) => item.object),
				);
				if (plan.imports.length) scope.importAnnotations(plan.imports);
				if (plan.annotationOverrides.length) {
					const apply = () => scope.updateAnnotations(plan.annotationOverrides);
					if (history) history.withoutRecording(apply);
					else apply();
					scope.commit();
				}
			}
			setTimeout(() => {
				if (cancelled) return;
				importingRef.current = false;
				initialImportDoneRef.current = true;
				if (!reloadRequiredRef.current) scope.setLocked(initialLockRef.current);
				// Subscribe only after loading this exact canonical base. A new
				// authoritative version invalidates replay from older open panes.
				if (paperAbsPath && annotationBase.content !== undefined) {
					peerSubscriptionRef.current?.();
					peerSubscriptionRef.current = subscribeAnnotationPeer(
						paperAbsPath,
						docId,
						applyPeerEvent,
						annotationBase.content,
					);
				}
				for (const event of pendingPeerEventsRef.current.splice(0))
					applyPeerEvent(event);
				rebuildHighlights();
			}, 0);
		})().catch((error) => {
			if (!cancelled) offerReload(error);
		});
		return () => {
			cancelled = true;
			if (!initialImportDoneRef.current) importedRef.current = false;
		};
	}, [
		annotationCap,
		annotationBase,
		offerReload,
		docCap,
		docId,
		totalPages,
		paperAbsPath,
		rebuildHighlights,
		applyPeerEvent,
		history,
	]);

	// Disk changes require reopening this PDF from its original bytes. An
	// additive import cannot apply remote deletions; clearing the plugin scope
	// would also delete native PDF annotations absent from the sidecar. Preserve
	// this working copy and offer an explicit per-viewer reload instead.
	useEffect(() => {
		if (!paperAbsPath || !annotationCap || totalPages <= 0) return;
		const target = normalizePathKey(
			joinVaultPath(marksDir(paperAbsPath), ANNOTATIONS_FILE),
		);
		let cancelled = false;
		let burstTimer: number | null = null;

		const schedule = () => {
			if (burstTimer !== null) return;
			burstTimer = window.setTimeout(() => {
				burstTimer = null;
				void checkDisk().catch(offerReload);
			}, ANNOTATIONS_REIMPORT_BURST_MS);
		};

		const checkDisk = async () => {
			if (cancelled || reloadRequiredRef.current) return;
			if (!initialImportDoneRef.current || importingRef.current) {
				schedule();
				return;
			}
			await enqueueAnnotationSave(paperAbsPath, async () => {
				if (cancelled || reloadRequiredRef.current) return;
				const raw = await readAnnotationFileContent(paperAbsPath);
				if (cancelled || raw === annotationBase.content) return;
				invalidateAnnotationPeers(paperAbsPath, raw);
				freezeForReload();
				// Never recursively enqueue while holding this queue slot. The
				// frozen scope is preserved before its reload action is offered.
				await saveAnnotationSnapshot(
					paperAbsPath,
					() =>
						annotationCap.forDocument(docId).exportAnnotations().toPromise(),
					{ ...annotationBase },
					() => !cancelled,
				);
				if (!cancelled)
					offerReload(
						new Error(
							i18n.t("app:diskConflict.title", { name: ANNOTATIONS_FILE }),
						),
					);
			});
		};

		const unsub = listenVaultFileChangedGated((payload) => {
			const paths = [...payload.paths];
			if (payload.rename) {
				paths.push(payload.rename.from, payload.rename.to);
			}
			const hit = paths.filter((p) => normalizePathKey(p) === target);
			if (!hit.length) return;
			if (hit.every((p) => isRecentSelfWrite(p))) return;
			schedule();
		});
		return () => {
			cancelled = true;
			if (burstTimer !== null) window.clearTimeout(burstTimer);
			unsub();
		};
	}, [
		annotationCap,
		annotationBase,
		docId,
		paperAbsPath,
		totalPages,
		freezeForReload,
		offerReload,
	]);

	const createHighlights = useCallback(
		(
			pages: FormattedSelection[],
			color: HighlightColor,
			quote: string,
			translatedPages?: readonly VisibleSelectionPage[],
			shape: PdfTextMarkupKind = "highlight",
		) => {
			const scope = annotationCap?.forDocument(docId);
			if (!scope || reloadRequiredRef.current || !initialImportDoneRef.current)
				return [] as { pageIndex: number; id: string }[];
			const underline = shape === "underline";
			const created: { pageIndex: number; id: string }[] = [];
			runAnnotationBatch(() => {
				for (const page of pages) {
					const id = crypto.randomUUID();
					const translatedRects = translatedPages?.find(
						(item) => item.pageIndex === page.pageIndex,
					)?.rects;
					const custom: HighlightCustom = {
						app: "agentero",
						paletteKey: color,
						quote,
					};
					if (translatedRects?.length) custom.translatedRects = translatedRects;
					const base = {
						id,
						pageIndex: page.pageIndex,
						rect: page.rect,
						segmentRects: page.segmentRects,
						strokeColor: HIGHLIGHT_HEX[color],
						// Underlines read as a solid stroke; highlights keep the
						// translucent fill used by the palette.
						opacity: underline ? 1 : HIGHLIGHT_OPACITY,
						created: new Date(),
						custom,
					};
					const obj: PdfHighlightAnnoObject | PdfUnderlineAnnoObject = underline
						? { ...base, type: PdfAnnotationSubtype.UNDERLINE }
						: { ...base, type: PdfAnnotationSubtype.HIGHLIGHT };
					scope.createAnnotation(page.pageIndex, obj);
					created.push({ pageIndex: page.pageIndex, id });
				}
			});
			return created;
		},
		[annotationCap, docId, runAnnotationBatch],
	);

	const updateHighlightComment = useCallback(
		(pageIndex: number, id: string, comment: string) => {
			const scope = annotationCap?.forDocument(docId);
			if (!scope || reloadRequiredRef.current || !initialImportDoneRef.current)
				return;
			const tracked = scope.getAnnotationById(id);
			if (!tracked || !isLiveAnnotation(tracked)) return;
			if ((tracked.object.contents?.trim() ?? "") === comment.trim()) return;
			scope.updateAnnotation(pageIndex, id, {
				contents: comment.trim() || undefined,
			});
		},
		[annotationCap, docId],
	);

	const updateHighlightColor = useCallback(
		(pageIndex: number, id: string, color: HighlightColor) => {
			const scope = annotationCap?.forDocument(docId);
			if (!scope || reloadRequiredRef.current || !initialImportDoneRef.current)
				return;
			const tracked = scope.getAnnotationById(id);
			if (
				!tracked ||
				!isLiveAnnotation(tracked) ||
				!isTextMarkupObject(tracked.object)
			) {
				return;
			}
			const obj = tracked.object;
			const custom = (obj.custom ?? {}) as HighlightCustom;
			if (
				custom.paletteKey === color &&
				obj.strokeColor === HIGHLIGHT_HEX[color]
			)
				return;
			scope.updateAnnotation(pageIndex, id, {
				strokeColor: HIGHLIGHT_HEX[color],
				custom: { ...custom, paletteKey: color },
			});
		},
		[annotationCap, docId],
	);

	useEffect(() => {
		if (!annotationCap) return;
		const queue = createAnnotationDeleteQueue(
			annotationCap.forDocument(docId),
			(error) =>
				notifyError(i18n.t("viewer:pdf.annotationDeleteFailed"), {
					description: error === undefined ? undefined : errorText(error),
				}),
			history
				? (action) => {
						history.withoutRecording(action);
						annotationCap.forDocument(docId).commit();
					}
				: undefined,
		);
		deleteQueueRef.current = queue;
		return () => {
			queue.dispose();
			if (deleteQueueRef.current === queue) deleteQueueRef.current = null;
		};
	}, [annotationCap, docId, history]);

	useEffect(() => {
		if (!annotationCap || !history) return;
		const replay = createAnnotationHistoryReplay(
			annotationCap.forDocument(docId),
			history,
			(error) => notifyError(errorText(error)),
		);
		historyReplayRef.current = replay;
		return () => {
			replay.dispose();
			if (historyReplayRef.current === replay) historyReplayRef.current = null;
		};
	}, [annotationCap, docId, history]);

	const deleteHighlightAnnotation = useCallback(
		(pageIndex: number, id: string) => {
			if (reloadRequiredRef.current || !initialImportDoneRef.current) return;
			deleteQueueRef.current?.delete(pageIndex, id);
		},
		[],
	);

	return {
		runAnnotationBatch,
		replayAnnotationHistory,
		highlights,
		highlightsRef,
		highlightAnchors,
		citationLinks,
		rebuildHighlights,
		createHighlights,
		updateHighlightComment,
		updateHighlightColor,
		deleteHighlightAnnotation,
	};
}
