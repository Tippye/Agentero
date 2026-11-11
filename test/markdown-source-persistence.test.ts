// @vitest-environment happy-dom
import { BaseLinkPlugin } from "@platejs/link";
import { MarkdownPlugin } from "@platejs/markdown";
import { createSlatePlugin, KEYS } from "platejs";
import { createPlateEditor } from "platejs/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMarkdownPersistence } from "@/components/editor/hooks/use-markdown-persistence";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";

const native = vi.hoisted(() => ({
	enabled: false,
	content: "# Initial\n",
	conflicts: [] as string[],
	write: vi.fn(),
	notify: vi.fn(),
	assets: new Set<string>(),
	removeAsset: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
	exists: vi.fn(async (path: string) => native.assets.has(path)),
	remove: native.removeAsset,
	readTextFile: vi.fn(async () => native.content),
	readFile: vi.fn(),
}));
vi.mock("@/lib/core/tauri", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/core/tauri")>()),
	isTauri: () => native.enabled,
}));
vi.mock("@/lib/core/bindings", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/core/bindings")>();
	return {
		...original,
		commands: { ...original.commands, vaultWriteTextFile: native.write },
	};
});
vi.mock("@/lib/core/notify", () => ({ notifyError: native.notify }));

const seed = "# Initial\n";
let initialMarkdown = seed;
const path = "/vault/note.md";
let filePath = path;
let root: ReturnType<typeof createRoot>;
let editor: ReturnType<typeof createPlateEditor>;
let persistence: ReturnType<typeof useMarkdownPersistence>;
let write: (path: string, md: string, last: string) => Promise<boolean>;
let blocked = false;
let unmounted = false;

function Host() {
	persistence = useMarkdownPersistence({
		editor,
		initialMarkdown,
		filePath,
		saveBlocked: blocked,
		filePathRef: { current: filePath },
		onAssetsChangedRef: { current: undefined },
		onPersist: write,
	});
	return null;
}

async function mountRichAsset() {
	await act(() => root.unmount());
	vi.useFakeTimers();
	vi.stubGlobal("requestIdleCallback", undefined);
	native.enabled = true;
	editor = createPlateEditor({
		plugins: [
			BaseLinkPlugin,
			createSlatePlugin({
				key: KEYS.img,
				node: { isElement: true, isVoid: true },
			}),
			MarkdownPlugin,
		],
		value: [
			{ type: "p", children: [{ text: "Before" }] },
			{ type: "img", url: "./assets/figure.png", children: [{ text: "" }] },
			{ type: "p", children: [{ text: "After" }] },
		],
	});
	initialMarkdown = editor.getApi(MarkdownPlugin).markdown.serialize();
	native.content = initialMarkdown;
	const asset = "/vault/assets/figure.png";
	native.assets.add(asset);
	const { writeVaultFile } = await import("@/lib/vault/fs");
	vi.mocked(write).mockImplementation(async (file, markdown, lastSaved) => {
		try {
			await writeVaultFile(file, markdown, { expectedContent: lastSaved });
			return true;
		} catch {
			return false;
		}
	});
	root = createRoot(document.createElement("div"));
	await act(() => root.render(createElement(Host)));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(251);
	});
	return asset;
}

async function removeRichAsset() {
	await act(() => {
		const index = editor.children.findIndex((node) => node.type === "img");
		expect(index).toBeGreaterThanOrEqual(0);
		editor.tf.removeNodes({ at: [index] });
		persistence.noteDocumentChanged();
	});
}

describe("source mode persistence", () => {
	beforeEach(async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		filePath = path;
		initialMarkdown = seed;
		editor = createPlateEditor({ plugins: [BaseLinkPlugin, MarkdownPlugin] });
		root = createRoot(document.createElement("div"));
		write = vi.fn(async () => true);
		blocked = false;
		unmounted = false;
		native.enabled = false;
		native.content = seed;
		native.conflicts = [];
		native.notify.mockClear();
		native.assets.clear();
		native.removeAsset.mockReset().mockImplementation(async (path: string) => {
			native.assets.delete(path);
		});
		native.write
			.mockReset()
			.mockImplementation(
				async (
					_path: string,
					content: string,
					guarded: boolean,
					expected: string | null,
				) => {
					if (guarded && native.content !== expected) {
						native.conflicts.push(content);
						return {
							status: "ok",
							data: {
								ok: false,
								error: {
									message: "Draft preserved as note (conflict hash).md",
									details: { conflictPreserved: true },
								},
							},
						};
					}
					native.content = content;
					return { status: "ok", data: { ok: true, data: null } };
				},
			);
		await act(() => root.render(createElement(Host)));
	});

	afterEach(async () => {
		if (!unmounted) await act(() => root.unmount());
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("flushes exact edited text after restoring Plate, including frontmatter and empty documents", async () => {
		const raw = "---\r\ntitle: Exact  \r\n---\r\n\r\n*kept as typed*\u200B  \n";
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => raw);
			const { body, frontmatter } = splitFrontmatter(raw);
			persistence.endSource(deserializeMarkdownBody(editor, body), frontmatter);
			await persistence.saveNow();
		});
		expect(persistence.frontmatterYaml).toBe("title: Exact  ");
		expect(write).toHaveBeenLastCalledWith(path, raw, seed);
		expect(editor.history.undos).toHaveLength(0);
		await act(async () => {
			persistence.beginSource(raw);
			persistence.updateSource(() => "");
			await persistence.saveNow();
		});
		expect(write).toHaveBeenLastCalledWith(path, "", raw);
	});

	it("cleans legacy inline placeholders when saving rich text while preserving empty paragraphs", async () => {
		const legacy =
			"\u200B[link](https://example.com)\u200B\n\n\u200B\n\n\u200B\n\nB\n";
		await act(async () => {
			persistence.applyExternalMarkdown(legacy);
			await persistence.saveNow();
		});
		expect(write).toHaveBeenCalledExactlyOnceWith(
			path,
			"[link](https://example.com)\n\n\u200B\n\n\u200B\n\nB\n",
			legacy,
		);
	});

	it("keeps the saved baseline on conflict and reloads the source buffer only when told to", async () => {
		vi.mocked(write).mockResolvedValueOnce(false);
		const local = "source  \n";
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => local);
			expect(await persistence.saveNow()).toBe(false);
		});
		expect(persistence.savedRef.current).toBe(seed);
		expect(persistence.serialize()).toBe(local);
		expect(persistence.dirtyRef.current).toBe(true);

		await act(() => {
			persistence.applyExternalMarkdown("# External\n");
		});
		expect(persistence.serialize()).toBe("# External\n");
		expect(persistence.dirtyRef.current).toBe(false);
	});

	it("reloads rendered documents by reusing unchanged blocks in place", async () => {
		const three = "# Head\n\nPara one.\n\nPara two.\n";
		await act(() => {
			persistence.applyExternalMarkdown(three);
		});
		const [heading, firstPara, lastPara] = editor.children;
		const edited = "# Head\n\nPara one edited.\n\nPara two.\n";
		await act(() => {
			persistence.applyExternalMarkdown(edited);
		});
		// Unchanged blocks keep their live node objects: all-new objects make
		// slate-react remount every block, which flickers the pane on each
		// sibling-pane save echo.
		expect(editor.children[0]).toBe(heading);
		expect(editor.children[2]).toBe(lastPara);
		expect(editor.children[1]).not.toBe(firstPara);
		expect(persistence.serialize()).toContain("Para one edited.");
		expect(persistence.dirtyRef.current).toBe(false);
		expect(persistence.savedRef.current).toBe(edited);
		await act(() => {
			expect(persistence.applyExternalMarkdown(edited)).toBe(false);
		});
	});

	it("queues a newer source edit behind an in-flight save", async () => {
		let release = (_ok: boolean) => {};
		vi.mocked(write).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => "first\n");
			const saving = persistence.saveNow();
			persistence.updateSource(() => "second  \n");
			release(true);
			await saving;
		});
		expect(write).toHaveBeenNthCalledWith(1, path, "first\n", seed);
		expect(write).toHaveBeenNthCalledWith(2, path, "second  \n", "first\n");
		expect(persistence.dirtyRef.current).toBe(false);
	});

	it("preserves the exact latest source draft after close when an older in-flight save is rejected", async () => {
		native.enabled = true;
		let release = (_ok: boolean) => {};
		vi.mocked(write).mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					release = resolve;
				}),
		);
		let saving: Promise<boolean> | undefined;
		let destroyed = false;
		const latest = "---\r\ntitle: Final  \r\n---\r\n\r\n*last draft*\u200b  \n";
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => "older draft\n");
			saving = persistence.saveNow();
		});
		await act(async () => {
			persistence.updateSource(() => {
				if (destroyed) throw new Error("source editor destroyed");
				return latest;
			});
			root.unmount();
		});
		unmounted = true;
		destroyed = true;
		native.content = "# Synced while saving\r\n";
		release(false);
		await saving;
		await vi.waitFor(() => expect(native.notify).toHaveBeenCalled());
		expect(native.conflicts).toEqual([latest]);
		expect(native.write).toHaveBeenLastCalledWith(path, latest, true, seed);
		expect(native.content).toBe("# Synced while saving\r\n");
		expect(native.notify).toHaveBeenCalledWith(
			expect.stringContaining(".md"),
			expect.objectContaining({ action: undefined }),
		);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("retains immutable final text and expected bytes in a global retry after a blocked editor closes", async () => {
		native.enabled = true;
		native.content = "# Remote\n";
		const local = "## Retained local  \r\n";
		let destroyed = false;
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => {
				if (destroyed) throw new Error("source editor destroyed");
				return local;
			});
		});
		blocked = true;
		await act(() => root.render(createElement(Host)));
		native.write.mockResolvedValueOnce({
			status: "ok",
			data: { ok: false, error: { message: "conflict file disk full" } },
		});
		await act(async () => {
			root.unmount();
		});
		unmounted = true;
		destroyed = true;
		await vi.waitFor(() => expect(native.notify).toHaveBeenCalled());
		expect(write).not.toHaveBeenCalled();
		const options = native.notify.mock.calls.at(-1)?.[1] as {
			action?: { onClick: () => void };
		};
		expect(options.action).toBeDefined();
		// A later baseline must never be borrowed by this old immutable export.
		persistence.savedRef.current = native.content;
		options.action?.onClick();
		await vi.waitFor(() => expect(native.conflicts).toEqual([local]));
		expect(native.write).toHaveBeenLastCalledWith(path, local, true, seed);
		expect(native.content).toBe("# Remote\n");
	});

	it("does not bypass the remote persistence callback with a native teardown rescue", async () => {
		native.enabled = true;
		filePath = "remote:session/notes.md";
		await act(() => root.render(createElement(Host)));
		await act(() => {
			persistence.beginSource(seed);
			persistence.updateSource(() => "remote draft\n");
		});
		blocked = true;
		await act(() => root.render(createElement(Host)));
		await act(() => root.unmount());
		unmounted = true;
		expect(native.write).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("retains a canonical-referenced image after a rich draft removal, rejected native save and close", async () => {
		const asset = await mountRichAsset();
		expect(native.content).toContain("./assets/figure.png");
		const canonical = `Remote edit\n\n${native.content}`;
		await removeRichAsset();
		native.content = canonical;
		await act(async () => {
			expect(await persistence.saveNow()).toBe(false);
		});
		expect(native.write).toHaveBeenCalled();
		expect(native.conflicts[0]).not.toContain("./assets/figure.png");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15_000);
		});
		expect(native.assets.has(asset)).toBe(true);
		expect(native.removeAsset).not.toHaveBeenCalled();
		await act(async () => {
			root.unmount();
		});
		unmounted = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15_000);
		});
		expect(native.content).toBe(canonical);
		expect(native.assets.has(asset)).toBe(true);
		expect(native.removeAsset).not.toHaveBeenCalled();
	});

	it("defers queued image deletion through a pending save and close until canonical removal is confirmed", async () => {
		const asset = await mountRichAsset();
		const publish = native.write.getMockImplementation();
		let release = () => {};
		let enter = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		native.write.mockImplementationOnce(async (...args) => {
			enter();
			await pending;
			return publish?.(...args);
		});
		await removeRichAsset();
		let saving: Promise<boolean> | undefined;
		await act(async () => {
			saving = persistence.saveNow();
		});
		await entered;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15_000);
		});
		expect(native.content).toContain("./assets/figure.png");
		expect(native.removeAsset).not.toHaveBeenCalled();
		await act(async () => {
			root.unmount();
		});
		unmounted = true;
		expect(native.assets.has(asset)).toBe(true);
		await act(async () => {
			release();
			await saving;
		});
		expect(native.content).not.toContain("./assets/figure.png");
		expect(native.removeAsset).toHaveBeenCalledExactlyOnceWith(asset);
		expect(native.assets.has(asset)).toBe(false);
	});

	it("writes a kept draft past a sibling hold without unblocking autosave", async () => {
		await act(async () => {
			persistence.beginSource(seed);
			persistence.updateSource(() => "# Draft\n");
		});
		blocked = true;
		await act(() => root.render(createElement(Host)));
		await act(async () => {
			expect(await persistence.saveNow()).toBe(false);
		});
		expect(write).not.toHaveBeenCalled();

		// "Keep draft": adopt the newer disk bytes as the baseline, then write
		// this draft over them on purpose.
		await act(async () => {
			persistence.adoptDiskBaseline("# Newer on disk\n");
			expect(await persistence.saveNow(true)).toBe(true);
		});
		expect(write).toHaveBeenCalledWith(path, "# Draft\n", "# Newer on disk\n");

		// The permission belonged to that one save: autosave is still held.
		await act(async () => {
			persistence.updateSource(() => "# Draft again\n");
			expect(await persistence.saveNow()).toBe(false);
		});
		expect(write).toHaveBeenCalledTimes(1);
		expect(persistence.dirtyRef.current).toBe(true);
	});
});
