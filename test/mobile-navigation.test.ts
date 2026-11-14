// @vitest-environment happy-dom
// @vitest-environment-options {"happyDOM":{"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}}
import { act, createElement, type ReactNode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobilePlazaActions } from "@/lib/mobile/navigation";
import type { PaperMetadata } from "@/lib/paper/types";

const state = vi.hoisted(() => ({
	navigate: vi.fn(),
	selected: vi.fn(),
	query: vi.fn(),
	tag: vi.fn(),
	info: vi.fn(),
	imported: vi.fn(),
	opened: vi.fn(),
	error: vi.fn(),
	panel: vi.fn(),
	legacySkill: vi.fn(),
	desktopVault: vi.fn(),
	close: vi.fn(),
	settings: vi.fn(),
	pair: vi.fn(),
	t: (key: string) => key,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/core/notify", () => ({ notifyError: state.error }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: state.opened }));
vi.mock("@/components/agent/agent-logo", () => ({
	AgentLogo: () => createElement("span", null, "Agent"),
}));
vi.mock("@/components/paper/paper-title", () => ({
	PaperTitle: ({ text }: { text: string }) => text,
}));
vi.mock("@/components/mobile/mobile-bridge-reset", () => ({
	MobileBridgeReset: () => null,
}));
vi.mock("@/components/plaza/plaza-tab-view", () => ({
	PlazaTabView: (props: {
		active: boolean;
		path: string;
		mobile: MobilePlazaActions;
	}) => {
		useEffect(() => {
			state.panel(props);
		}, [props]);
		return createElement("div", { "data-plaza-panel": props.path }, "panel");
	},
}));
vi.mock("@/hooks/use-app-stores", () => ({
	useVaultStore: state.desktopVault,
}));
vi.mock("@/hooks/use-iframe-drag-shield", () => ({
	useIframeDragShield: () => {
		throw new Error("Desktop drag hook must not mount");
	},
}));
vi.mock("@/components/viewer/web-view/use-web-view-selection", () => ({
	useWebViewSelection: () => {
		throw new Error("Desktop selection bridge must not mount");
	},
}));
vi.mock("@/components/plaza/use-plaza-frame-zoom", () => ({
	usePlazaFrameZoom: () => {
		throw new Error("Desktop frame zoom must not mount");
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
vi.mock("@/lib/plaza/import", () => ({
	importPlazaSkillRepo: state.legacySkill,
	importPlazaPaper: vi.fn(),
}));
vi.mock("@/lib/plaza/imported", () => ({ importedIdsInLibrary: vi.fn() }));

import {
	MobileLibraryNavigation,
	type MobileLibraryNavigationProps,
} from "@/components/mobile/mobile-library-navigation";
import { MobilePlazaPage } from "@/components/mobile/mobile-plaza-page";
import { MobileSidebar } from "@/components/mobile/mobile-sidebar";
import { PlazaSkillsView } from "@/components/plaza/plaza-skills-view";
import { PlazaWebFrame } from "@/components/plaza/plaza-web-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	filterMobilePapers,
	mobilePaperImportReference,
	mobilePaperTagCounts,
	openMobilePlazaUrl,
} from "@/lib/mobile/navigation";
import { PLAZA_SOURCES } from "@/lib/plaza/sources";

function paper(
	id: string,
	title: string,
	tags: PaperMetadata["tags"] = [],
): PaperMetadata {
	return {
		id,
		title,
		tags,
		path: `papers/${id}`,
		type: "other",
		authors: ["Ada Author"],
		status: "completed",
		is_read: false,
		added_at: "2026-11-12",
		updated_at: "2026-11-12",
	};
}
const papers = [
	paper("a", "Alpha analysis", [
		"Vision",
		{ name: "vision" },
		"@zotero:private",
	]),
	{
		...paper("b", "Beta methods", ["Robotics"]),
		doi: "10.1000/beta",
		year: 2024,
	},
];
const mobile: MobilePlazaActions = {
	vaultPath: "/private/Vault",
	onImportPaper: state.imported,
	onOpenUrl: state.opened,
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
async function render(element: ReactNode) {
	await act(async () => root.render(element));
}
function button(label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find(
		(item) =>
			item.getAttribute("aria-label") === label || item.textContent === label,
	);
	if (!found) throw new Error(`Missing ${label}`);
	return found;
}
async function click(label: string) {
	await act(async () => button(label).click());
}
function navProps(
	overrides: Partial<MobileLibraryNavigationProps> = {},
): MobileLibraryNavigationProps {
	return {
		active: "library",
		onNavigate: state.navigate,
		papers,
		selectedPaperId: "a",
		onSelectPaper: state.selected,
		query: "",
		onQueryChange: state.query,
		selectedTag: null,
		onTagChange: state.tag,
		onImport: state.imported,
		onPaperInfo: state.info,
		...overrides,
	};
}

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.clearAllMocks();
	state.opened.mockResolvedValue(undefined);
	state.legacySkill.mockResolvedValue(undefined);
	state.desktopVault.mockImplementation(() => {
		throw new Error("Desktop Vault store must not mount");
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	vi.restoreAllMocks();
});

describe("mobile navigation and Plaza", () => {
	it("offers Library, Plaza and Agent without a writing area, and dispatches only the selected target", async () => {
		await render(createElement(MobileLibraryNavigation, navProps()));
		expect(
			container.querySelector('[aria-label="tabs.library"]'),
		).not.toBeNull();
		expect(container.querySelector('[aria-label="tabs.plaza"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="tabs.agent"]')).not.toBeNull();
		expect(container.textContent).not.toMatch(/writing|写作/i);
		expect(state.navigate).not.toHaveBeenCalled();
		await click("tabs.plaza");
		expect(state.navigate).toHaveBeenCalledExactlyOnceWith("plaza");
		expect(state.imported).not.toHaveBeenCalled();
		expect(state.selected).not.toHaveBeenCalled();
	});
	it("filters actual catalog papers and visible tags without exposing connector provenance", () => {
		expect(mobilePaperTagCounts(papers)).toEqual([
			{ name: "Robotics", count: 1 },
			{ name: "Vision", count: 1 },
		]);
		expect(
			filterMobilePapers(papers, "ada vision", "VISION").map((item) => item.id),
		).toEqual(["a"]);
		expect(
			filterMobilePapers(papers, "10.1000/beta 2024").map((item) => item.id),
		).toEqual(["b"]);
		expect(filterMobilePapers(papers, "@zotero:private")).toEqual([]);
	});
	it("routes paper open, paper info and magic import independently", async () => {
		await render(
			createElement(
				MobileLibraryNavigation,
				navProps({ query: "Alpha", selectedTag: "Vision" }),
			),
		);
		expect(container.textContent).toContain("Alpha analysis");
		expect(container.textContent).not.toContain("Beta methods");
		await click("Alpha analysis");
		expect(state.selected).toHaveBeenCalledExactlyOnceWith(papers[0]);
		await click("navigation.paperInfo");
		expect(state.info).toHaveBeenCalledExactlyOnceWith(papers[0]);
		expect(state.selected).toHaveBeenCalledOnce();
		await click("navigation.import");
		expect(state.imported).toHaveBeenCalledOnce();
	});
	it("keeps query and tag selection controlled by the parent", async () => {
		await render(createElement(MobileLibraryNavigation, navProps()));
		const input = container.querySelector("input");
		if (!input) throw new Error("Missing library search");
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "Ada");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(state.query).toHaveBeenCalledWith("Ada");
		const vision = [...container.querySelectorAll("button")].find(
			(item) => item.textContent === "Vision1",
		);
		if (!vision) throw new Error("Missing Vision tag");
		await act(async () => vision.click());
		expect(state.tag).toHaveBeenCalledExactlyOnceWith("Vision");
		await click("navigation.allPapers");
		expect(state.tag).toHaveBeenLastCalledWith(null);
	});
	it("keeps All papers available when an info update removes the last selected tag", async () => {
		const tagged = [paper("last", "Last tagged paper", ["Vision"])];
		await render(
			createElement(
				MobileLibraryNavigation,
				navProps({ papers: tagged, selectedTag: "Vision" }),
			),
		);
		expect(container.textContent).toContain("Last tagged paper");
		const refreshed = [paper("last", "Last tagged paper", [])];
		await render(
			createElement(
				MobileLibraryNavigation,
				navProps({ papers: refreshed, selectedTag: "Vision" }),
			),
		);
		expect(container.textContent).not.toContain("Last tagged paper");
		await click("navigation.allPapers");
		expect(state.tag).toHaveBeenCalledExactlyOnceWith(null);
		await render(
			createElement(
				MobileLibraryNavigation,
				navProps({ papers: refreshed, selectedTag: null }),
			),
		);
		expect(container.textContent).toContain("Last tagged paper");
	});
	it("preserves pairing and settings callbacks and owns safe insets only on the drawer", async () => {
		await render(
			createElement(MobileSidebar, {
				open: true,
				status: { paired: false, connected: false },
				onClose: state.close,
				onStatus: vi.fn(),
				onDisconnect: async () => {},
				onPairAnother: state.pair,
				onSettings: state.settings,
			}),
		);
		expect(
			container.querySelector("aside")?.classList.contains("mobile-safe-area"),
		).toBe(true);
		expect(container.querySelector("footer")?.className).toBe("border-t p-4");
		await click("tabs.settings");
		await click("settings.addDevice");
		expect(state.settings).toHaveBeenCalledOnce();
		expect(state.pair).toHaveBeenCalledOnce();
		expect(state.close).toHaveBeenCalledTimes(2);
	});
	it("does not mount a Plaza panel before explicit activation and remounts it per source or reload", async () => {
		const props = {
			active: false,
			vaultPath: "/private/Vault",
			path: PLAZA_SOURCES[0].path,
			reloadKey: 0,
			onImportPaper: state.imported,
		};
		await render(createElement(MobilePlazaPage, props));
		expect(state.panel).not.toHaveBeenCalled();
		expect(state.imported).not.toHaveBeenCalled();
		await render(createElement(MobilePlazaPage, { ...props, active: true }));
		expect(state.panel).toHaveBeenCalledOnce();
		const mounted = state.panel.mock.calls[0][0];
		expect(mounted.mobile.vaultPath).toBe("/private/Vault");
		expect(mounted.mobile.onImportPaper).toBe(state.imported);
		const panel = container.querySelector("[data-plaza-panel]");
		expect(panel?.getAttribute("data-plaza-panel")).toBe(PLAZA_SOURCES[0].path);
		await render(
			createElement(MobilePlazaPage, {
				...props,
				active: true,
				path: PLAZA_SOURCES[1].path,
			}),
		);
		expect(
			container
				.querySelector("[data-plaza-panel]")
				?.getAttribute("data-plaza-panel"),
		).toBe(PLAZA_SOURCES[1].path);
		const switched = container.querySelector("[data-plaza-panel]");
		expect(switched).not.toBe(panel);
		await render(
			createElement(MobilePlazaPage, {
				...props,
				active: true,
				path: PLAZA_SOURCES[1].path,
				reloadKey: 1,
			}),
		);
		expect(container.querySelector("[data-plaza-panel]")).not.toBe(switched);
		await render(createElement(MobilePlazaPage, props));
		expect(container.querySelector("[data-plaza-panel]")).toBeNull();
	});
	it("uses a sandboxed public web preview without a mobile toolbar and no desktop Vault hooks", async () => {
		await render(
			createElement(PlazaWebFrame, {
				homeUrl: "https://papers.cool/",
				embedOrigin: "agentero-coolpapers://localhost",
				title: "Papers",
				mobile,
			}),
		);
		const frame = container.querySelector("iframe");
		expect(frame?.src).toBe("https://papers.cool/");
		expect(frame?.getAttribute("sandbox")).not.toContain("allow-popups");
		expect(state.desktopVault).not.toHaveBeenCalled();
		expect(
			container.querySelector('[aria-label="plaza.openBrowser"]'),
		).toBeNull();
		expect(container.querySelector('[aria-label="plaza.reload"]')).toBeNull();
		await act(async () => frame?.dispatchEvent(new Event("error")));
		expect(container.textContent).toContain("plaza.embedUnavailable");
		expect(container.querySelector("iframe")).toBeNull();
		expect(state.opened).not.toHaveBeenCalled();
	});
	it("resets failed preview state when the source identity changes", async () => {
		await render(
			createElement(PlazaWebFrame, {
				homeUrl: "https://papers.cool/",
				embedOrigin: null,
				title: "First",
				mobile,
			}),
		);
		await act(async () =>
			container.querySelector("iframe")?.dispatchEvent(new Event("error")),
		);
		await render(
			createElement(PlazaWebFrame, {
				homeUrl: "https://modelscope.cn/papers",
				embedOrigin: null,
				title: "Second",
				mobile,
			}),
		);
		expect(container.querySelector("iframe")?.src).toBe(
			"https://modelscope.cn/papers",
		);
		expect(container.textContent).not.toContain("plaza.embedUnavailable");
	});
	it("makes mobile skill picks browse-only instead of executing a local skill import", async () => {
		await render(
			createElement(
				TooltipProvider,
				null,
				createElement(PlazaSkillsView, { mobile }),
			),
		);
		const repo = [...container.querySelectorAll("button")].find((item) =>
			item.textContent?.includes("/"),
		);
		if (!repo) throw new Error("Missing curated repository");
		await act(async () => repo.click());
		expect(state.opened).toHaveBeenCalledOnce();
		expect(state.legacySkill).not.toHaveBeenCalled();
		expect(state.imported).not.toHaveBeenCalled();
	});
	it("passes identifiers and reviewed titles to one native lookup path", () => {
		expect(
			mobilePaperImportReference({
				title: "A paper",
				arxivId: "2501.01234",
				url: "https://arxiv.org/abs/2501.01234",
			}),
		).toBe("arXiv:2501.01234");
		expect(
			mobilePaperImportReference({
				title: "A paper",
				url: "https://doi.org/10.1000/example",
			}),
		).toBe("https://doi.org/10.1000/example");
		expect(
			mobilePaperImportReference({
				title: "Reviewed title",
				url: "https://paperswithcode.co/paper/opaque-slug",
			}),
		).toBe("Reviewed title");
	});
	it("opens only HTTP links through the native opener and never hides a failure behind window.open", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {},
		});
		const popup = vi.spyOn(window, "open");
		await openMobilePlazaUrl("https://papers.cool/");
		expect(state.opened).toHaveBeenCalledExactlyOnceWith(
			"https://papers.cool/",
		);
		state.opened.mockRejectedValueOnce(new Error("Native opener failed"));
		await expect(
			openMobilePlazaUrl("https://modelscope.cn/papers"),
		).rejects.toThrow("Native opener failed");
		await expect(openMobilePlazaUrl("javascript:alert(1)")).rejects.toThrow(
			"Unsupported external link",
		);
		expect(popup).not.toHaveBeenCalled();
	});
});
