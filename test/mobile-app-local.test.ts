// @vitest-environment happy-dom
import { act, createElement, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClientStatus } from "@/lib/bridge/client";
import type { PaperMetadata } from "@/lib/paper/types";

const state = vi.hoisted(() => ({
	t: (key: string) => key,
	status: { paired: false, connected: false } as BridgeClientStatus,
	paper: {
		id: "example",
		path: "papers/example",
		title: "Offline paper",
		authors: [],
	} as PaperMetadata,
	mounts: 0,
	remoteMounts: 0,
	dirty: null as ((dirty: boolean) => void) | null,
	error: vi.fn(),
	refresh: vi.fn(async (_rescan?: boolean) => {}),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock("@/components/mobile/hooks/use-mobile-vault", () => ({
	useMobileVault: () => ({
		vaultPath: "/private/Vault",
		loading: false,
		retry: vi.fn(),
	}),
}));
vi.mock("@/components/mobile/hooks/use-mobile-papers", () => ({
	useMobilePapers: () => ({
		papers: [state.paper],
		loading: false,
		refresh: state.refresh,
	}),
}));
vi.mock("@/components/mobile/hooks/use-mobile-paper-sync", () => ({
	useMobilePaperSync: () => ({
		states: {},
		setPinned: vi.fn(),
		fetchMissing: vi.fn(async () => false),
		progressText: null,
	}),
}));
vi.mock("@/components/mobile/hooks/use-mobile-agents", () => ({
	useMobileAgents: () => ({
		agents: [],
		loading: false,
		selectedAgent: null,
		selectedAgentId: null,
		selectAgent: vi.fn(),
	}),
}));
vi.mock("@/components/mobile/hooks/use-bridge-status", () => ({
	useBridgeStatus: () => ({
		status: state.status,
		setStatus: vi.fn(),
		pairPending: null,
	}),
}));
vi.mock("@/components/mobile/hooks/use-pair-offer-links", () => ({
	usePairOfferLinks: vi.fn(),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: state.error }));
vi.mock("@/lib/mobile/import-pdf", () => ({ importMobilePdfs: vi.fn() }));
vi.mock("@/components/mobile/mobile-agent-page", () => ({
	MobileAgentPage: () => createElement("div", null, "remote-agent"),
}));
vi.mock("@/components/mobile/remote/mobile-remote-agent-page", () => ({
	MobileRemoteAgentPage: ({ active }: { active: boolean }) => {
		const [draft, setDraft] = useState("");
		useEffect(() => {
			state.remoteMounts += 1;
		}, []);
		return createElement(
			"div",
			{ "data-remote": true, "data-active": String(active) },
			"dsh-agent",
			draft,
			createElement(
				"button",
				{ type: "button", onClick: () => setDraft("unsent-dsh-draft") },
				"edit-remote-draft",
			),
		);
	},
}));
vi.mock("@/components/mobile/mobile-gestures", () => ({
	useHorizontalSwipe: () => ({}),
	EdgeSwipeBack: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/mobile/mobile-header", () => ({
	MobileHeader: ({
		title,
		leading,
		trailing,
		onBrandClick,
	}: {
		title: string;
		leading: ReactNode;
		trailing: ReactNode;
		onBrandClick: () => void;
	}) =>
		createElement(
			"header",
			null,
			createElement(
				"button",
				{ type: "button", onClick: onBrandClick },
				"menu",
			),
			title,
			leading,
			trailing,
		),
}));
vi.mock("@/components/mobile/mobile-header-actions", () => ({
	MobileReaderModeToggle: () => null,
	MobileAgentToolbar: () => null,
}));
vi.mock("@/components/mobile/mobile-library-page", () => ({
	MobileLibraryPage: ({
		onSelect,
	}: {
		onSelect: (paper: PaperMetadata) => void;
	}) =>
		createElement(
			"button",
			{ type: "button", onClick: () => onSelect(state.paper) },
			"open-local-paper",
		),
}));
vi.mock("@/components/mobile/mobile-nav", () => ({
	MobileNav: ({ onTab }: { onTab: (tab: string) => void }) =>
		createElement(
			"nav",
			null,
			createElement(
				"button",
				{ type: "button", onClick: () => onTab("library") },
				"library-tab",
			),
			createElement(
				"button",
				{ type: "button", onClick: () => onTab("agent") },
				"agent-tab",
			),
		),
}));
vi.mock("@/components/mobile/mobile-sidebar", () => ({
	MobileSidebar: ({
		open,
		onPairAnother,
		onSync,
		navigation,
	}: {
		open: boolean;
		onPairAnother: () => void;
		onSync: () => void;
		navigation: ReactNode;
	}) =>
		open
			? createElement(
					"aside",
					null,
					navigation,
					createElement(
						"button",
						{ type: "button", onClick: onSync },
						"open-sync",
					),
					createElement(
						"button",
						{ type: "button", onClick: onPairAnother },
						"pair-desktop",
					),
				)
			: null,
}));
vi.mock("@/components/mobile/mobile-sync-panel", () => ({
	MobileSyncPanel: ({
		open,
		vaultPath,
		onOpenChange,
		onSynced,
	}: {
		open: boolean;
		vaultPath: string;
		onOpenChange: (open: boolean) => void;
		onSynced: () => Promise<void>;
	}) =>
		open
			? createElement(
					"div",
					{ "data-sync-vault": vaultPath },
					createElement(
						"button",
						{ type: "button", onClick: () => void onSynced() },
						"sync-completed",
					),
					createElement(
						"button",
						{ type: "button", onClick: () => onOpenChange(false) },
						"close-sync",
					),
				)
			: null,
}));
vi.mock("@/components/mobile/mobile-pairing", () => ({
	MobilePairing: ({ onDone }: { onDone: () => void }) =>
		createElement(
			"button",
			{ type: "button", onClick: onDone },
			"cancel-pairing",
		),
}));
vi.mock("@/components/mobile/mobile-reader-page", () => ({
	MobileReaderPage: ({
		onNotesDirtyChange,
	}: {
		onNotesDirtyChange: (dirty: boolean) => void;
	}) => {
		state.dirty = onNotesDirtyChange;
		useEffect(() => {
			state.mounts += 1;
		}, []);
		return createElement("div", { "data-reader": true }, "local-reader");
	},
}));
vi.mock("@/components/ui/dialog", () => ({
	Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
		open ? children : null,
	DialogContent: ({ children }: { children: ReactNode }) =>
		createElement("div", null, children),
	DialogTitle: ({ children }: { children: ReactNode }) =>
		createElement("h2", null, children),
}));

import MobileApp from "@/components/mobile/mobile-app";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
async function click(text: string) {
	const button = [...host.querySelectorAll("button")].find(
		(element) => element.textContent === text,
	);
	expect(button, text).toBeDefined();
	await act(() => button?.click());
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	state.status = { paired: false, connected: false };
	state.mounts = 0;
	state.remoteMounts = 0;
	state.dirty = null;
	state.error.mockClear();
	state.refresh.mockClear();
	host = document.createElement("div");
	root = createRoot(host);
	await act(async () => {
		root.render(createElement(MobileApp));
	});
});
afterEach(async () => {
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});

describe("mobile local-first shell", () => {
	it("opens the local library while unpaired and retains its reader through Agent and optional pairing", async () => {
		expect(host.textContent).toContain("open-local-paper");
		expect(host.textContent).not.toContain("cancel-pairing");
		await click("open-local-paper");
		await click("agent-tab");
		const provider = host.querySelector<HTMLSelectElement>(
			'[aria-label="remote.provider"]',
		);
		expect(provider?.value).toBe("ds-harness-remote");
		expect(
			host.querySelector("[data-remote]")?.getAttribute("data-active"),
		).toBe("true");
		await click("edit-remote-draft");
		await click("library-tab");
		expect(
			host.querySelector("[data-remote]")?.getAttribute("data-active"),
		).toBe("false");
		await click("agent-tab");
		expect(host.textContent).toContain("unsent-dsh-draft");
		expect(state.remoteMounts).toBe(1);
		await act(() => {
			const currentProvider = host.querySelector<HTMLSelectElement>(
				'[aria-label="remote.provider"]',
			);
			if (currentProvider) {
				currentProvider.value = "agentero-bridge";
				currentProvider.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(host.textContent).toContain("agent.connectionRequired");
		expect(host.querySelector("[data-reader]")).not.toBeNull();
		await click("connect.title");
		expect(host.textContent).toContain("cancel-pairing");
		await click("cancel-pairing");
		await click("library-tab");
		expect(state.mounts).toBe(1);
		expect(host.textContent).toContain("Offline paper");
	});

	it("opens sync for the local Vault and rescans completed sync without losing the mounted reader", async () => {
		await click("open-local-paper");
		await act(() => state.dirty?.(true));
		await click("menu");
		await click("open-sync");
		expect(
			host.querySelector("[data-sync-vault]")?.getAttribute("data-sync-vault"),
		).toBe("/private/Vault");
		await click("sync-completed");
		expect(state.refresh).toHaveBeenCalledExactlyOnceWith(true);
		await click("close-sync");
		expect(state.mounts).toBe(1);
		expect(host.querySelector("[data-reader]")).not.toBeNull();
	});

	it("does not discard a failed or pending notes save when going back", async () => {
		await click("open-local-paper");
		await act(() => state.dirty?.(true));
		await act(() =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="reader.back"]')
				?.click(),
		);
		expect(state.error).toHaveBeenCalledWith("reader.unsavedChanges");
		expect(host.querySelector("[data-reader]")).not.toBeNull();
		await act(() => state.dirty?.(false));
		await act(() =>
			host
				.querySelector<HTMLButtonElement>('[aria-label="reader.back"]')
				?.click(),
		);
		expect(host.textContent).toContain("open-local-paper");
	});
});
