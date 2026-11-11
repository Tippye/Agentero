// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownEditorProps } from "@/components/editor/markdown-editor";
import { useWikiNav, type WikiNavContextValue } from "@/lib/wiki/nav-context";

const state = vi.hoisted(() => ({
	t: (key: string) => key,
	props: null as MarkdownEditorProps | null,
	wiki: null as WikiNavContextValue | null,
	exists: vi.fn(async () => true),
	read: vi.fn(async () => "# Saved\n"),
	persist: vi.fn(
		async (_path: string, _markdown: string, _last: string, _writer: string) =>
			true,
	),
	error: vi.fn(),
}));
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: state.t }),
}));
vi.mock("@/lib/vault/fs", () => ({
	readVaultFile: state.read,
	vaultPathExists: state.exists,
}));
vi.mock("@/lib/workspace/persistence", () => ({ persistFile: state.persist }));
vi.mock("@/lib/core/notify", () => ({ notifyError: state.error }));
vi.mock("@/components/editor/markdown-editor", () => ({
	MarkdownEditor: (props: MarkdownEditorProps) => {
		state.props = props;
		state.wiki = useWikiNav();
		return createElement("article", { "data-editor": true });
	},
}));

import { MobileNotesEditor } from "@/components/mobile/mobile-notes-editor";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const path = "/private/Vault/papers/example/NOTES.md";
const dirty = vi.fn();
const render = async (active = true) => {
	await act(async () => {
		root.render(
			createElement(MobileNotesEditor, {
				path,
				vaultPath: "/private/Vault",
				active,
				onDirtyChange: dirty,
			}),
		);
	});
};
const editorReady = async () => {
	await vi.waitFor(async () => {
		await act(async () => {});
		expect(state.props).not.toBeNull();
	});
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	state.props = null;
	state.wiki = null;
	state.exists.mockResolvedValue(true);
	state.read.mockResolvedValue("# Saved\n");
	state.persist.mockResolvedValue(true);
	host = document.createElement("div");
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});

describe("mobile notes with shared Markdown persistence", () => {
	it("loads from the local file and forwards autosaves with the fixed path and disk baseline", async () => {
		await render();
		await editorReady();
		expect(state.props).toMatchObject({
			initialMarkdown: "# Saved\n",
			filePath: path,
			active: true,
			showToolbar: true,
		});
		await act(async () => {
			expect(
				await state.props?.onPersist?.(path, "# Draft\n", "# Saved\n"),
			).toBe(true);
		});
		expect(state.persist).toHaveBeenCalledExactlyOnceWith(
			path,
			"# Draft\n",
			"# Saved\n",
			`mobile:${path}`,
		);
		await render(false);
		expect(state.read).toHaveBeenCalledTimes(1);
		expect(state.props?.active).toBe(false);
	});

	it("provides local Vault and source-note scope to wiki completion and embed consumers", async () => {
		await render();
		await editorReady();
		expect(state.wiki).toMatchObject({
			vaultPath: "/private/Vault",
			mdFiles: ["papers/example/NOTES.md"],
		});
		expect(state.props?.filePath).toBe(path);
		const context = state.wiki;
		await render(false);
		expect(state.wiki).toBe(context);
	});

	it("uses editor navigation for same-note headings and blocks while reporting unsupported targets", async () => {
		await render();
		await editorReady();
		const sameNote = {
			targetRaw: "#Introduction",
			path: "papers/example/NOTES.md",
			status: "resolved" as const,
		};
		await act(() =>
			state.wiki?.onWikiNavigate({
				...sameNote,
				fragment: { kind: "heading", path: ["Introduction"] },
			}),
		);
		expect(state.props?.navigationIntent).toEqual({
			id: 1,
			fragment: { kind: "heading", path: ["Introduction"] },
		});
		await act(() =>
			state.wiki?.onWikiNavigate({
				...sameNote,
				fragment: { kind: "block", id: "result" },
			}),
		);
		expect(state.props?.navigationIntent).toEqual({
			id: 2,
			fragment: { kind: "block", id: "result" },
		});
		await act(() => {
			state.wiki?.onWikiNavigate({ ...sameNote, path: "notes/other.md" });
			state.wiki?.onWikiNavigate({
				...sameNote,
				fragment: { kind: "annotation", id: "highlight" },
			});
			state.wiki?.onWikiNavigate({
				...sameNote,
				status: "missing",
				path: null,
			});
		});
		expect(state.error).toHaveBeenCalledTimes(3);
		expect(state.error).toHaveBeenLastCalledWith("reader.linkUnavailable");
		expect(state.props?.navigationIntent?.id).toBe(2);
	});

	it("holds failed conflict saves and reuses the editor's explicit load/keep controls", async () => {
		await render();
		await editorReady();
		state.read.mockResolvedValue("# External\n");
		state.persist.mockResolvedValue(false);
		await act(async () => {
			expect(
				await state.props?.onPersist?.(path, "# Draft\n", "# Saved\n"),
			).toBe(false);
		});
		expect(state.props?.saveConflict).toBe(true);
		expect(state.props?.initialMarkdown).toBe("# Saved\n");
		await act(() =>
			state.props?.onResolveSaveConflict?.(
				`mobile:${path}`,
				"load",
				"# External\n",
			),
		);
		expect(state.props).toMatchObject({
			initialMarkdown: "# External\n",
			reloadKey: 1,
			saveConflict: false,
		});
		await act(() =>
			state.props?.onResolveSaveConflict?.(
				`mobile:${path}`,
				"hold",
				"# External\n",
			),
		);
		expect(state.props?.saveConflict).toBe(true);
		await act(() =>
			state.props?.onResolveSaveConflict?.(
				`mobile:${path}`,
				"keep",
				"# External\n",
			),
		);
		expect(state.props?.saveConflict).toBe(false);
	});

	it("does not expose an empty editable note after a read failure", async () => {
		state.read.mockRejectedValueOnce(new Error("permission denied"));
		await render();
		expect(state.error).toHaveBeenCalledWith("permission denied");
		expect(host.querySelector("[data-editor]")).toBeNull();
		expect(host.textContent).toContain("local.retry");
	});
});
