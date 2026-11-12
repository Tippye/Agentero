// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FeedSub } from "@/lib/plaza/feeds";

const io = vi.hoisted(() => ({
	t: (key: string) => key,
	list: vi.fn(),
	items: vi.fn(),
	refresh: vi.fn(),
	add: vi.fn(),
	remove: vi.fn(),
	rename: vi.fn(),
	pin: vi.fn(),
	read: vi.fn(),
	markImported: vi.fn(),
	resolveBody: vi.fn(),
	import: vi.fn(),
	external: vi.fn(),
	copy: vi.fn(),
	error: vi.fn(),
	navigate: vi.fn(),
}));
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: io.t }),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: io.error }));
vi.mock("@/lib/core/clipboard", () => ({ copyTextToClipboard: io.copy }));
// Empty feed bodies are irrelevant to the real subscription view and its portal menu.
vi.mock("@/components/plaza/plaza-feeds-item", () => ({
	PlazaFeedItemDetail: () => null,
	PlazaFeedItemRow: () => null,
}));
vi.mock("@/lib/plaza/feeds", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/plaza/feeds")>()),
	feedsList: io.list,
	feedsItems: io.items,
	feedsRefresh: io.refresh,
	feedsAdd: io.add,
	feedsRemove: io.remove,
	feedsRename: io.rename,
	feedsSetPinned: io.pin,
	feedsSetRead: io.read,
	feedsMarkImported: io.markImported,
	feedsResolveBody: io.resolveBody,
	importFeedItem: io.import,
}));

import { PlazaFeedsView } from "@/components/plaza/plaza-feeds-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dismissMobileBackLayer, hasMobileBackLayer } from "@/lib/mobile/back";

const subscription: FeedSub = {
	id: "feed-vision",
	title: "Vision research",
	url: "https://rss.arxiv.org/rss/cs.CV",
	addedAt: "2026-11-12",
	lastFetchedAt: "2026-11-12",
	lastError: null,
	itemCount: 0,
	pinned: false,
	pinnedAt: null,
};
let systemBack: () => void = () => {};
function Harness() {
	const [page, setPage] = useState("plaza");
	systemBack = () => {
		if (dismissMobileBackLayer()) return;
		io.navigate("library");
		setPage("library");
	};
	return createElement(
		TooltipProvider,
		null,
		page === "plaza"
			? createElement(PlazaFeedsView, {
					mobile: {
						vaultPath: "/private/Vault",
						onImportPaper: io.import,
						onOpenUrl: io.external,
					},
				})
			: createElement("div", null, "Library"),
	);
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.clearAllMocks();
	io.list.mockResolvedValue([subscription]);
	io.items.mockResolvedValue([]);
	io.refresh.mockResolvedValue({
		subscriptions: [subscription],
		fetched: 0,
		failed: 0,
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function button(label: string) {
	const target = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(item) =>
			item.textContent === label || item.getAttribute("aria-label") === label,
	);
	if (!target) throw new Error(`Missing ${label}`);
	return target;
}

it("uses the first Android Back to dismiss the actual RSS menu while preserving its feed and view", async () => {
	await act(async () => root.render(createElement(Harness)));
	const feed = button(subscription.title);
	await act(async () => feed.click());
	expect(io.items).toHaveBeenLastCalledWith({
		subscriptionId: subscription.id,
		filter: "all",
	});
	expect(feed.classList.contains("bg-foreground/10")).toBe(true);
	await act(async () => button("plaza.feeds.more").click());
	// The business menu deliberately binds its capture listener on the next timer.
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	const menu = document.querySelector('[role="menu"][data-viewport-floating]');
	expect(menu).not.toBeNull();
	expect(menu?.getAttribute("data-state")).toBe("open");
	expect(hasMobileBackLayer()).toBe(true);
	const reads = io.items.mock.calls.length;
	const refreshes = io.refresh.mock.calls.length;
	await act(async () => systemBack());
	expect(
		document.querySelector('[role="menu"][data-viewport-floating]'),
	).toBeNull();
	expect(hasMobileBackLayer()).toBe(false);
	expect(button(subscription.title)).toBe(feed);
	expect(feed.isConnected).toBe(true);
	expect(feed.classList.contains("bg-foreground/10")).toBe(true);
	expect(io.navigate).not.toHaveBeenCalled();
	expect(io.items).toHaveBeenCalledTimes(reads);
	expect(io.refresh).toHaveBeenCalledTimes(refreshes);
	for (const action of [
		io.add,
		io.remove,
		io.rename,
		io.pin,
		io.read,
		io.markImported,
		io.resolveBody,
		io.import,
		io.external,
		io.copy,
		io.error,
	])
		expect(action).not.toHaveBeenCalled();
	await act(async () => systemBack());
	expect(io.navigate).toHaveBeenCalledExactlyOnceWith("library");
	expect(feed.isConnected).toBe(false);
});
