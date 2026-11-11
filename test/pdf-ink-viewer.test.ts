// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePdfInk } from "@/components/viewer/pdf/hooks/use-pdf-ink";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	apply: vi.fn(),
	watch: undefined as ((event: { paths: string[] }) => void) | undefined,
}));
vi.mock("@/lib/pdf/ink-api", () => ({
	readPdfInk: mocks.read,
	applyPdfInk: mocks.apply,
}));
vi.mock("@/lib/vault/file-change-gate", () => ({
	listenVaultFileChangedGated: (listener: typeof mocks.watch) => {
		mocks.watch = listener;
		return () => {};
	},
}));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
let root: Root, container: HTMLDivElement;
let ink: ReturnType<typeof usePdfInk>;
const dirty = vi.fn(),
	mode = vi.fn();
function Reader() {
	ink = usePdfInk({
		vaultPath: "/vault",
		paperRelPath: "papers/ink-viewer",
		enabled: true,
		editable: true,
		isActive: true,
		onInkDirtyChange: dirty,
		onInkModeChange: mode,
	});
	return null;
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	mocks.read.mockResolvedValue({
		document: { version: 1, page: 1, strokes: [], tombstones: [] },
		revision: null,
		creationTimes: {},
		updateTimes: {},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() => root.render(createElement(Reader)));
	await act(async () => {
		await ink.editor?.controller.load(1);
	});
});
afterEach(async () => {
	await act(() => {
		ink.editor?.controller.discard();
		root.unmount();
	});
	container.remove();
	vi.unstubAllGlobals();
});
it("shares saved ink with a read-only embed without sharing or disarming reader tools", async () => {
	await act(() => ink.editor?.setMode("pen"));
	const active = ink.editor;
	let readonlyEditor: typeof active = null;
	function Embed() {
		readonlyEditor = usePdfInk({
			vaultPath: "/vault",
			paperRelPath: "papers/ink-viewer",
			enabled: true,
			editable: false,
			isActive: true,
		}).editor;
		return null;
	}
	const node = document.createElement("div");
	document.body.append(node);
	const embedRoot = createRoot(node);
	await act(() => embedRoot.render(createElement(Embed)));
	expect(readonlyEditor?.controller).toBe(active?.controller);
	expect(active?.getState().mode).toBe("pen");
	await act(() => embedRoot.unmount());
	node.remove();
	expect(active?.getState().mode).toBe("pen");
});
const page = {
	page: 1,
	width: 100,
	height: 200,
	rotation: 0,
	element: {} as HTMLElement,
};
const sample = { x: 10, y: 20, pressure: 0.5, elapsedMs: 0, tilt: null };
it("reports active ink synchronously to parent guards before pointerup and restores reading ownership", async () => {
	await act(() => {
		ink.editor?.setMode("pen");
		expect(mode).toHaveBeenLastCalledWith(true);
		ink.editor?.begin(page, sample);
		expect(dirty).toHaveBeenLastCalledWith(true);
		expect(mocks.apply).not.toHaveBeenCalled();
		// The viewer's region and Read actions use the same explicit disarm.
		ink.editor?.setMode("read");
		expect(mode).toHaveBeenLastCalledWith(false);
		expect(dirty).toHaveBeenLastCalledWith(false);
	});
	expect(ink.editor?.getState().draft).toBeNull();
});
it("keeps a failed draft and parent dirty through an engine remount, and filters sync events to this paper", async () => {
	mocks.apply.mockRejectedValue(
		Object.assign(new Error("offline"), { code: "ink_unavailable" }),
	);
	await act(async () => {
		ink.editor?.setMode("pen");
		ink.editor?.begin(page, sample);
		ink.editor?.finish();
	});
	expect(dirty).toHaveBeenLastCalledWith(true);
	expect(dirty.mock.calls.map(([value]) => value)).toEqual([false, true]);
	const originalEditor = ink.editor;
	const pending = originalEditor?.controller.getPage(1).pending;
	await act(() => root.unmount());
	root = createRoot(container);
	await act(() => root.render(createElement(Reader)));
	expect(ink.editor?.controller).toBe(originalEditor?.controller);
	expect(ink.editor?.controller.getPage(1).pending).toEqual(pending);
	expect(dirty).toHaveBeenLastCalledWith(true);
	await act(async () => {
		ink.editor?.controller.discard();
		await Promise.resolve();
	});
	await vi.waitFor(() =>
		expect(ink.editor?.controller.getPage(1).loading).toBe(false),
	);
	mocks.read.mockClear();
	await act(() =>
		mocks.watch?.({ paths: ["/vault/papers/other/marks/ink/p1.json"] }),
	);
	expect(mocks.read).not.toHaveBeenCalled();
	await act(async () => {
		mocks.watch?.({ paths: ["/vault/papers/ink-viewer/marks/ink/p1.json"] });
		await Promise.resolve();
	});
	expect(mocks.read).toHaveBeenCalledOnce();
});
