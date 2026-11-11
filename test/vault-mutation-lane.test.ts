// @vitest-environment happy-dom
import { PdfAnnotationSubtype } from "@embedpdf/models";
import type {
	AnnotationEvent,
	AnnotationTransferItem,
} from "@embedpdf/plugin-annotation/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	native: true,
	files: new Map<string, string>(),
	write: vi.fn(),
	remove: vi.fn(),
	pluginWriteText: vi.fn(),
	pluginWriteBytes: vi.fn().mockResolvedValue(undefined),
	pluginRemove: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	notify: vi.fn(),
	watcher: undefined as ((payload: { paths: string[] }) => void) | undefined,
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: mocks.notify }));
vi.mock("@/lib/vault/file-change-gate", () => ({
	listenVaultFileChangedGated: (listener: typeof mocks.watcher) => {
		mocks.watcher = listener;
		return () => {
			mocks.watcher = undefined;
		};
	},
}));
vi.mock("@/components/viewer/pdf/layers/citation-links", () => ({
	isLinkObject: (object: { type: number }) => object.type === 2,
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => mocks.native }));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		vaultWriteTextFile: mocks.write,
		vaultRemoveFile: mocks.remove,
	},
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
	readTextFile: vi.fn(async (path: string) => {
		if (!mocks.files.has(path)) throw new Error("missing");
		return mocks.files.get(path);
	}),
	readFile: vi.fn(),
	readDir: vi.fn().mockResolvedValue([]),
	exists: vi.fn(async (path: string) => mocks.files.has(path)),
	writeTextFile: mocks.pluginWriteText,
	writeFile: mocks.pluginWriteBytes,
	remove: mocks.pluginRemove,
	mkdir: mocks.mkdir,
}));
vi.mock("@/lib/vault/remote/remote-vault", () => ({
	parseRemoteJoinedPath: () => null,
}));
vi.mock("@/lib/vault", async () => ({
	...(await import("@/lib/vault/fs")),
	...(await import("@/lib/vault/path")),
}));

import {
	type AnnotationFileBase,
	loadAnnotationItems,
	saveAnnotationItems,
	saveAnnotationSnapshot,
} from "@/lib/pdf/highlight/annotation-store";
import { enqueueAnnotationSave } from "@/lib/pdf/highlight/annotation-sync";
import {
	removeVaultPath,
	writeVaultBytes,
	writeVaultFile,
} from "@/lib/vault/fs";

const path = "/vault/papers/a/marks/annotations.json";
const items = (id: string) => [{ id }] as AnnotationTransferItem[];

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	mocks.native = true;
	mocks.files.clear();
	mocks.write.mockImplementation(
		async (
			file: string,
			content: string,
			guard: boolean,
			expected: string | null,
		) => {
			if (guard && (mocks.files.get(file) ?? null) !== expected) {
				return {
					status: "ok",
					data: {
						ok: false,
						error: {
							code: "file_write_conflict",
							message: "conflict preserved",
							details: { conflictPreserved: true },
						},
					},
				};
			}
			mocks.files.set(file, content);
			return { status: "ok", data: { ok: true, data: null } };
		},
	);
	mocks.remove.mockResolvedValue({
		status: "ok",
		data: { ok: true, data: null },
	});
});

it("routes native text and mark deletes through generated guarded commands while preserving binary mkdir/write behavior", async () => {
	await writeVaultFile(path, "[]\n");
	expect(mocks.write).toHaveBeenCalledWith(path, "[]\n", false, null);
	expect(mocks.pluginWriteText).not.toHaveBeenCalled();
	await removeVaultPath(path);
	expect(mocks.remove).toHaveBeenCalledWith(path);
	expect(mocks.pluginRemove).not.toHaveBeenCalled();
	await removeVaultPath("/vault/papers/a");
	expect(mocks.pluginRemove).toHaveBeenCalledWith("/vault/papers/a", {
		recursive: true,
	});
	const bytes = new Uint8Array([0, 255, 42]);
	await writeVaultBytes("/vault/papers/a/assets/image.png", bytes);
	expect(mocks.mkdir).toHaveBeenCalledWith("/vault/papers/a/assets", {
		recursive: true,
	});
	expect(mocks.pluginWriteBytes).toHaveBeenCalledWith(
		"/vault/papers/a/assets/image.png",
		bytes,
	);
});

it("keeps a viewer's base independent of other reads and never advances it after a sync conflict", async () => {
	const original = '[{"id":"base"}]\n';
	mocks.files.set(path, original);
	const viewer: AnnotationFileBase = {};
	await loadAnnotationItems("/vault/papers/a", viewer);
	const remote = '[{"id":"base"},{"id":"remote"}]\n';
	mocks.files.set(path, remote);
	// A watcher refresh or reference lookup does not adopt a new working base.
	await loadAnnotationItems("/vault/papers/a");
	const otherViewer: AnnotationFileBase = {};
	await loadAnnotationItems("/vault/papers/a", otherViewer);
	await expect(
		saveAnnotationItems("/vault/papers/a", items("local"), viewer),
	).rejects.toThrow("conflict preserved");
	expect(mocks.write).toHaveBeenLastCalledWith(
		path,
		`${JSON.stringify(items("local"), null, 2)}\n`,
		true,
		original,
	);
	expect(viewer.content).toBe(original);
	expect(otherViewer.content).toBe(remote);
	expect(mocks.files.get(path)).toBe(remote);
	expect(mocks.remove).not.toHaveBeenCalled();
});

it("advances only the successful viewer base and retains exact bytes between successive saves", async () => {
	const viewer: AnnotationFileBase = {};
	await loadAnnotationItems("/vault/papers/a", viewer);
	expect(viewer.content).toBeNull();
	await saveAnnotationItems("/vault/papers/a", items("one"), viewer);
	const first = mocks.files.get(path);
	await saveAnnotationItems("/vault/papers/a", items("two"), viewer);
	expect(mocks.write.mock.calls[0]?.[3]).toBeNull();
	expect(mocks.write.mock.calls[1]?.[3]).toBe(first);
	expect(viewer.content).toBe(mocks.files.get(path));
});

it("binds an in-flight export to its captured old bytes even if a later read adopts a newer base", async () => {
	const original = '[{"id":"original"}]\n';
	const remote = '[{"id":"remote"}]\n';
	mocks.files.set(path, original);
	const base: AnnotationFileBase = {};
	await loadAnnotationItems("/vault/papers/a", base);
	let release: (value: AnnotationTransferItem[]) => void = () => {};
	const pendingExport = new Promise<AnnotationTransferItem[]>((resolve) => {
		release = resolve;
	});
	const saving = saveAnnotationSnapshot(
		"/vault/papers/a",
		() => pendingExport,
		base,
	);
	mocks.files.set(path, remote);
	Object.assign(base, { content: remote });
	const failed = expect(saving).rejects.toThrow("conflict preserved");
	release(items("older-export"));
	await failed;
	expect(mocks.write.mock.calls[0]?.[3]).toBe(original);
	expect(mocks.files.get(path)).toBe(remote);
	expect(base.content).toBe(remote);
});

it("retires queued exports before reload without invoking their old snapshot or borrowing a fresh base", async () => {
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const blocker = enqueueAnnotationSave("/vault/papers/a", () => pending);
	let epoch = 0;
	const capturedEpoch = epoch;
	const oldExport = vi.fn(async () => items("retired"));
	const base: AnnotationFileBase = { path, content: "old" };
	const retired = enqueueAnnotationSave("/vault/papers/a", () =>
		saveAnnotationSnapshot(
			"/vault/papers/a",
			oldExport,
			base,
			() => capturedEpoch === epoch,
		),
	);
	// Recovery freezes this viewer and retires its old exports before a fresh
	// document/working copy can load. Native PDF objects are never cleared here.
	epoch += 1;
	Object.assign(base, { content: "remote" });
	release();
	await Promise.all([blocker, retired]);
	expect(oldExport).not.toHaveBeenCalled();
	expect(mocks.write).not.toHaveBeenCalled();
	expect(base.content).toBe("remote");
});

it("refuses corrupt disk data and unloaded native saves instead of coercing to an empty store", async () => {
	mocks.files.set(path, "{broken");
	const viewer: AnnotationFileBase = {};
	await expect(
		loadAnnotationItems("/vault/papers/a", viewer),
	).rejects.toThrow();
	await expect(
		saveAnnotationItems("/vault/papers/a", [], viewer),
	).rejects.toThrow("must be loaded");
	expect(mocks.write).not.toHaveBeenCalled();
	expect(mocks.files.get(path)).toBe("{broken");
});

it("guards legacy migration against a sync arrival and leaves the legacy proposal available on conflict", async () => {
	const { readTextFile } = await import("@tauri-apps/plugin-fs");
	const legacy = '[{"id":"legacy"}]\n';
	const remote = '[{"id":"sync-arrival"}]\n';
	mocks.files.set("/vault/papers/a/annotations.json", legacy);
	vi.mocked(readTextFile)
		.mockRejectedValueOnce(new Error("missing"))
		.mockImplementationOnce(async () => {
			mocks.files.set(path, remote);
			return legacy;
		});
	await expect(loadAnnotationItems("/vault/papers/a", {})).rejects.toThrow(
		"conflict preserved",
	);
	expect(mocks.write.mock.calls[0]?.[2]).toBe(true);
	expect(mocks.write.mock.calls[0]?.[3]).toBeNull();
	expect(mocks.files.get(path)).toBe(remote);
	expect(mocks.files.get("/vault/papers/a/annotations.json")).toBe(legacy);
	expect(mocks.remove).not.toHaveBeenCalled();
});

it("keeps browser annotation storage in memory without invoking native commands", async () => {
	mocks.native = false;
	await saveAnnotationItems("browser-only", items("memory"));
	expect(await loadAnnotationItems("browser-only")).toEqual(items("memory"));
	expect(mocks.write).not.toHaveBeenCalled();
});

it("freezes a stale viewer and reloads only after preserving its latest export, without deleting native PDF objects", async () => {
	vi.useFakeTimers();
	const { usePdfHighlights } = await import(
		"@/components/viewer/pdf/hooks/use-pdf-highlights"
	);
	const native = {
		id: "native-pdf-link",
		type: PdfAnnotationSubtype.LINK,
		pageIndex: 0,
		rect: { origin: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
	};
	const nativeItems = [{ annotation: native }] as AnnotationTransferItem[];
	let latest = nativeItems;
	const scope = {
		getAnnotations: vi.fn(() => [{ object: native, commitState: "synced" }]),
		onAnnotationEvent: vi.fn(() => () => {}),
		onStateChange: vi.fn(() => () => {}),
		getState: vi.fn(() => ({ byUid: {}, hasPendingChanges: false })),
		setActiveTool: vi.fn(),
		setLocked: vi.fn(),
		deleteAnnotation: vi.fn(),
		importAnnotations: vi.fn(),
		updateAnnotations: vi.fn(),
		exportAnnotations: vi.fn(() => ({ toPromise: async () => latest })),
	};
	const reload = vi.fn();
	const annotationCap = { forDocument: () => scope };
	const docCap = {
		getDocument: () => ({ pages: [{ size: { width: 600, height: 800 } }] }),
	};
	const highlightsRef = { current: undefined };
	function Probe() {
		usePdfHighlights({
			annotationCap: annotationCap as unknown as Parameters<
				typeof usePdfHighlights
			>[0]["annotationCap"],
			docCap: docCap as unknown as Parameters<
				typeof usePdfHighlights
			>[0]["docCap"],
			docId: "recovery-viewer",
			paperAbsPath: "/vault/papers/a",
			paperKey: "a",
			totalPages: 1,
			onHighlightsChangeRef: highlightsRef,
			onReloadAnnotations: reload,
		});
		return null;
	}
	const root = createRoot(document.createElement("div"));
	mocks.files.set(path, "[]\n");
	try {
		await act(async () => {
			root.render(createElement(Probe));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4001);
		});
		mocks.files.set(path, '[{"annotation":{"id":"remote"}}]\n');
		await act(async () => {
			mocks.watcher?.({ paths: [path] });
			await vi.advanceTimersByTimeAsync(250);
		});
		expect(scope.setLocked).toHaveBeenCalled();
		expect(scope.setActiveTool).toHaveBeenCalledWith(null);
		expect(scope.deleteAnnotation).not.toHaveBeenCalled();
		expect(scope.importAnnotations).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		const options = mocks.notify.mock.calls.at(-1)?.[1] as {
			action?: { onClick: () => void };
		};
		expect(options.action).toBeDefined();
		latest = [...nativeItems, ...items("last-pending-edit")];
		mocks.write.mockResolvedValueOnce({
			status: "ok",
			data: {
				ok: false,
				error: { message: "conflict copy permission denied" },
			},
		});
		await act(async () => {
			options.action?.onClick();
		});
		expect(reload).not.toHaveBeenCalled();
		// Retrying can remount only once exact pending bytes are preserved.
		await act(async () => {
			options.action?.onClick();
		});
		expect(mocks.write.mock.calls.at(-1)?.[1]).toBe(
			`${JSON.stringify(latest, null, 2)}\n`,
		);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(scope.deleteAnnotation).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount());
		vi.useRealTimers();
	}
});

it("captures the final working copy on unmount after debounce fired behind another pending save", async () => {
	vi.useFakeTimers();
	const { usePdfHighlights } = await import(
		"@/components/viewer/pdf/hooks/use-pdf-highlights"
	);
	const native = {
		id: "native-link",
		type: PdfAnnotationSubtype.LINK,
		pageIndex: 0,
		rect: { origin: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
	};
	const finalItems = [
		{ annotation: native },
		...items("last-edit"),
	] as AnnotationTransferItem[];
	let eventListener: ((event: AnnotationEvent) => void) | undefined;
	let destroyed = false;
	const scope = {
		getAnnotations: () => [{ object: native, commitState: "synced" }],
		onAnnotationEvent: (listener: typeof eventListener) => {
			eventListener = listener;
			return () => {};
		},
		onStateChange: () => () => {},
		getState: () => ({ byUid: {}, hasPendingChanges: false }),
		setLocked: vi.fn(),
		exportAnnotations: vi.fn(() => {
			if (destroyed) throw new Error("document destroyed");
			return { toPromise: async () => finalItems };
		}),
	};
	const annotationCap = { forDocument: () => scope };
	const docCap = {
		getDocument: () => ({ pages: [{ size: { width: 600, height: 800 } }] }),
	};
	const highlightsRef = { current: undefined };
	function Probe() {
		usePdfHighlights({
			annotationCap: annotationCap as unknown as Parameters<
				typeof usePdfHighlights
			>[0]["annotationCap"],
			docCap: docCap as unknown as Parameters<
				typeof usePdfHighlights
			>[0]["docCap"],
			docId: "unmount-viewer",
			paperAbsPath: "/vault/papers/a",
			paperKey: "a",
			totalPages: 1,
			onHighlightsChangeRef: highlightsRef,
		});
		return null;
	}
	const root = createRoot(document.createElement("div"));
	let release = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let blocker: Promise<void> | undefined;
	let unmounted = false;
	mocks.files.set(path, "[]\n");
	try {
		await act(async () => {
			root.render(createElement(Probe));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		blocker = enqueueAnnotationSave("/vault/papers/a", () => blocked);
		await act(async () => {
			eventListener?.({
				type: "create",
				committed: false,
				documentId: "unmount-viewer",
				pageIndex: 0,
				annotation: native,
			} as AnnotationEvent);
			await vi.advanceTimersByTimeAsync(650);
		});
		expect(scope.exportAnnotations).not.toHaveBeenCalled();
		await act(async () => {
			root.unmount();
		});
		unmounted = true;
		destroyed = true;
		expect(scope.exportAnnotations).toHaveBeenCalledTimes(1);
		mocks.write.mockResolvedValueOnce({
			status: "ok",
			data: { ok: false, error: { message: "disk full after close" } },
		});
		release();
		await blocker;
		await enqueueAnnotationSave("/vault/papers/a", async () => {});
		expect(scope.exportAnnotations).toHaveBeenCalledTimes(1);
		expect(mocks.notify.mock.calls.at(-1)?.[0]).toBe("disk full after close");
		const retry = mocks.notify.mock.calls.at(-1)?.[1] as {
			action?: { onClick: () => void };
		};
		expect(retry.action).toBeDefined();
		await act(async () => {
			retry.action?.onClick();
		});
		await enqueueAnnotationSave("/vault/papers/a", async () => {});
		expect(scope.exportAnnotations).toHaveBeenCalledTimes(1);
		expect(mocks.files.get(path)).toBe(
			`${JSON.stringify(finalItems, null, 2)}\n`,
		);
	} finally {
		release();
		await blocker;
		if (!unmounted) await act(async () => root.unmount());
		vi.useRealTimers();
	}
});

it("blocks annotation edits while the initial base is loading and keeps them blocked if that load fails", async () => {
	const { readTextFile } = await import("@tauri-apps/plugin-fs");
	const { usePdfHighlights } = await import(
		"@/components/viewer/pdf/hooks/use-pdf-highlights"
	);
	let rejectRead: (error: Error) => void = () => {};
	const loading = new Promise<string>((_resolve, reject) => {
		rejectRead = reject;
	});
	vi.mocked(readTextFile).mockImplementationOnce(() => loading);
	mocks.files.set(path, "[]\n");
	const scope = {
		getAnnotations: () => [],
		onAnnotationEvent: () => () => {},
		onStateChange: () => () => {},
		getState: () => ({
			locked: { type: "none" },
			byUid: {},
			hasPendingChanges: false,
		}),
		setLocked: vi.fn(),
		setActiveTool: vi.fn(),
		createAnnotation: vi.fn(),
	};
	const annotationCap = { forDocument: () => scope };
	const docCap = {
		getDocument: () => ({ pages: [{ size: { width: 600, height: 800 } }] }),
	};
	const highlightsRef = { current: undefined };
	let api: ReturnType<typeof usePdfHighlights> | undefined;
	function Probe() {
		api = usePdfHighlights({
			annotationCap: annotationCap as unknown as Parameters<
				typeof usePdfHighlights
			>[0]["annotationCap"],
			docCap: docCap as unknown as Parameters<
				typeof usePdfHighlights
			>[0]["docCap"],
			docId: "loading-viewer",
			paperAbsPath: "/vault/papers/a",
			paperKey: "a",
			totalPages: 1,
			onHighlightsChangeRef: highlightsRef,
		});
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () => {
			root.render(createElement(Probe));
		});
		const selection = [
			{
				pageIndex: 0,
				rect: { origin: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
				segmentRects: [],
			},
		] as Parameters<NonNullable<typeof api>["createHighlights"]>[0];
		expect(api?.createHighlights(selection, "yellow", "early edit")).toEqual(
			[],
		);
		expect(scope.createAnnotation).not.toHaveBeenCalled();
		await act(async () => {
			rejectRead(new Error("initial read denied"));
		});
		expect(api?.createHighlights(selection, "yellow", "still blocked")).toEqual(
			[],
		);
		expect(scope.createAnnotation).not.toHaveBeenCalled();
		expect(scope.setLocked.mock.calls.at(-1)?.[0]).toEqual({ type: "all" });
		expect(mocks.write).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount());
	}
});

it("propagates both IPC errors and inner host errors from native text writes", async () => {
	mocks.write.mockResolvedValueOnce({ status: "error", error: "IPC denied" });
	await expect(writeVaultFile(path, "[]")).rejects.toThrow("IPC denied");
	mocks.write.mockResolvedValueOnce({
		status: "ok",
		data: { ok: false, error: { message: "forbidden path" } },
	});
	await expect(writeVaultFile(path, "[]")).rejects.toThrow("forbidden path");
	expect(mocks.pluginWriteText).not.toHaveBeenCalled();
});
