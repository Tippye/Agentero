// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfViewerProps } from "@/components/viewer/pdf/types";
import type { PaperMetadata } from "@/lib/paper/types";

const state = vi.hoisted(() => ({
	t: (key: string) => key,
	viewer: null as PdfViewerProps | null,
	pdfMounts: 0,
	notesMounts: 0,
	notesPath: "",
	notesVault: "",
	load: vi.fn(async () => ({ source: null, bytes: new ArrayBuffer(4) })),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock("@/lib/mobile/paper-files", () => ({
	loadMobilePaperPdf: state.load,
	mobilePaperPaths: () => ({
		paperRelPath: "papers/example",
		paperAbsPath: "/private/Vault/papers/example",
		notesPath: "/private/Vault/papers/example/NOTES.md",
	}),
}));
vi.mock("@/components/viewer/pdf/pdf-viewer", () => ({
	PdfViewer: (props: PdfViewerProps) => {
		state.viewer = props;
		useEffect(() => {
			state.pdfMounts += 1;
		}, []);
		return createElement("div", { "data-pdf": true });
	},
}));
vi.mock("@/components/mobile/mobile-notes-editor", () => ({
	MobileNotesEditor: (props: { path: string; vaultPath: string }) => {
		state.notesPath = props.path;
		state.notesVault = props.vaultPath;
		useEffect(() => {
			state.notesMounts += 1;
		}, []);
		return createElement("div", { "data-notes": true });
	},
}));

import { MobileReaderPage } from "@/components/mobile/mobile-reader-page";

let root: ReturnType<typeof createRoot>;
let width = 500;
let resize: () => void;
let host: HTMLDivElement;
const paper = { id: "example", path: "papers/example" } as PaperMetadata;
const dirty = vi.fn();
const render = async (mode: "pdf" | "notes", active = true) => {
	await act(async () => {
		root.render(
			createElement(MobileReaderPage, {
				paper,
				vaultPath: "/private/Vault",
				mode,
				active,
				onNotesDirtyChange: dirty,
			}),
		);
	});
};

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => ({ width }) as DOMRect,
	);
	width = 500;
	state.pdfMounts = 0;
	state.notesMounts = 0;
	state.viewer = null;
	host = document.createElement("div");
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("mobile local reader", () => {
	it("passes local persistence paths and mounts one reader/editor across modes and width changes", async () => {
		await render("pdf");
		await vi.waitFor(async () => {
			await act(async () => {});
			expect(state.viewer).not.toBeNull();
		});
		expect(state.viewer).toMatchObject({
			paperAbsPath: "/private/Vault/papers/example",
			paperRelPath: "papers/example",
			vaultPath: "/private/Vault",
			isActive: true,
		});
		expect(state.notesPath).toBe("/private/Vault/papers/example/NOTES.md");
		expect(state.notesVault).toBe("/private/Vault");
		await render("notes");
		await act(() => {
			width = 1000;
			resize();
		});
		await render("pdf", false);
		expect(state.viewer?.isActive).toBe(false);
		expect(host.querySelectorAll("[data-pdf]")).toHaveLength(1);
		expect(host.querySelectorAll("[data-notes]")).toHaveLength(1);
		expect(state.pdfMounts).toBe(1);
		expect(state.notesMounts).toBe(1);
	});
});
