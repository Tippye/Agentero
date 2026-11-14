// @vitest-environment happy-dom
// @vitest-environment-options {"happyDOM":{"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}}
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobilePlazaControls } from "@/components/mobile/mobile-plaza-controls";
import { PlazaWebFrame } from "@/components/plaza/plaza-web-frame";
import type { MobilePlazaActions } from "@/lib/mobile/navigation";
import {
	PLAZA_SOURCES,
	plazaSourceForPath,
	plazaSourceLabel,
} from "@/lib/plaza/sources";

const state = vi.hoisted(() => ({
	path: vi.fn(),
	reload: vi.fn(),
	open: vi.fn(),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/components/viewer/web-view/use-web-view-selection", () => ({
	useWebViewSelection: () => {
		throw new Error("Desktop selection bridge must not mount");
	},
}));
vi.mock("@/hooks/use-iframe-drag-shield", () => ({
	useIframeDragShield: () => {
		throw new Error("Desktop drag hook must not mount");
	},
}));
vi.mock("@/components/plaza/use-plaza-frame-zoom", () => ({
	usePlazaFrameZoom: () => {
		throw new Error("Desktop frame zoom must not mount");
	},
}));
vi.mock("@/hooks/use-app-stores", () => ({
	useVaultStore: () => {
		throw new Error("Desktop Vault store must not mount");
	},
}));
vi.mock("@/components/sidebar/file-tree/move-destination-picker", () => ({
	MoveDestinationPicker: () => null,
}));
vi.mock("@/lib/paper/library-actions", () => ({
	currentLookupParentDir: () => {
		throw new Error("Desktop Vault authority must not be read");
	},
}));
vi.mock("@/lib/plaza/import", () => ({ importPlazaPaper: vi.fn() }));
vi.mock("@/lib/plaza/imported", () => ({ importedIdsInLibrary: vi.fn() }));

const withUrl = PLAZA_SOURCES.find((source) => source.url !== null);
const withoutUrl = PLAZA_SOURCES.find((source) => source.url === null);
if (!withUrl || !withoutUrl) throw new Error("Missing Plaza source fixtures");

const mobile: MobilePlazaActions = {
	vaultPath: "/private/Vault",
	onImportPaper: vi.fn(),
	onOpenUrl: state.open,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(element: ReactNode) {
	await act(async () => root.render(element));
}
function controls(path: string) {
	return createElement(MobilePlazaControls, {
		path,
		onPathChange: state.path,
		onReload: state.reload,
		onOpenUrl: state.open,
	});
}
function trigger(): HTMLButtonElement {
	const element = host.querySelector<HTMLButtonElement>(
		'[aria-label="plaza.source"]',
	);
	if (!element) throw new Error("Missing source picker");
	return element;
}
async function click(label: string) {
	const element = host.querySelector<HTMLButtonElement>(
		`[aria-label="${label}"]`,
	);
	if (!element) throw new Error(`Missing ${label}`);
	await act(async () => element.click());
	return element;
}

describe("mobile Plaza header controls", () => {
	it("shows the current source and dispatches reload, open and source changes", async () => {
		await render(controls(withUrl.path));
		expect(trigger().textContent).toContain(plazaSourceLabel(withUrl));
		expect(trigger().className).toContain("min-h-11");
		expect(trigger().className).toContain("min-w-0");
		expect(trigger().className).toContain("w-28");
		const refresh = await click("plaza.refresh");
		expect(refresh.className).toContain("size-11");
		expect(refresh.className).toContain("touch-manipulation");
		expect(state.reload).toHaveBeenCalledOnce();
		const open = await click("plaza.openBrowser");
		expect(open.textContent?.trim()).toBe("");
		expect(state.open).toHaveBeenCalledExactlyOnceWith(withUrl.url);
		await act(async () =>
			trigger().dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			),
		);
		const target = PLAZA_SOURCES[1];
		const option = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((element) => element.textContent === plazaSourceLabel(target));
		expect(option, plazaSourceLabel(target)).toBeDefined();
		await act(async () => option?.click());
		expect(state.path).toHaveBeenCalledExactlyOnceWith(target.path);
		expect(plazaSourceForPath(target.path)).toBe(target);
	});

	it("omits the browser action for a source without a public URL and keeps reload", async () => {
		await render(controls(withoutUrl.path));
		expect(withoutUrl.url).toBeNull();
		expect(host.querySelector('[aria-label="plaza.openBrowser"]')).toBeNull();
		expect(trigger().textContent).toContain(plazaSourceLabel(withoutUrl));
		await click("plaza.refresh");
		expect(state.reload).toHaveBeenCalledOnce();
	});

	it("falls back to the first source for an unknown path", async () => {
		await render(controls("agentero:plaza/missing"));
		expect(trigger().textContent).toContain(plazaSourceLabel(PLAZA_SOURCES[0]));
		await click("plaza.openBrowser");
		expect(state.open).toHaveBeenCalledExactlyOnceWith(PLAZA_SOURCES[0].url);
		expect(state.path).not.toHaveBeenCalled();
	});

	it("mounts the mobile web frame without its own toolbar", async () => {
		await render(
			createElement(PlazaWebFrame, {
				homeUrl: withUrl.url ?? "",
				embedOrigin: null,
				title: "Plaza preview",
				mobile,
			}),
		);
		const frame = host.querySelector("iframe");
		expect(frame?.getAttribute("src")).toBe(withUrl.url);
		expect(host.querySelector('[aria-label="plaza.reload"]')).toBeNull();
		expect(host.querySelector('[aria-label="plaza.openBrowser"]')).toBeNull();
		expect(
			[...host.querySelectorAll("button")].some((button) =>
				button.textContent?.includes("plaza.openBrowser"),
			),
		).toBe(false);
		expect(host.textContent).not.toContain("plaza.embedFallback");
		await act(async () => frame?.dispatchEvent(new Event("error")));
		expect(host.textContent).toContain("plaza.embedUnavailable");
		expect(host.querySelector("iframe")).toBeNull();
		expect(state.open).not.toHaveBeenCalled();
	});
});
