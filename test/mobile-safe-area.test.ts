// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	t: (key: string) => key,
	done: vi.fn(),
	close: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock("@/lib/bridge/client", () => ({
	bridgeConnect: vi.fn(),
	listenBridgeProgress: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/mobile/mobile-bridge-reset", () => ({
	MobileBridgeReset: () => null,
}));
vi.mock("@/components/mobile/mobile-download-settings", () => ({
	MobileDownloadSettings: () =>
		createElement("button", { type: "button" }, "last-download-action"),
}));
vi.mock("@/components/settings/panes/sync-pane", () => ({
	SyncPane: () => createElement("input", { "aria-label": "storage-setting" }),
}));
vi.mock("@zxing/browser", () => ({
	BrowserQRCodeReader: class {
		decodeFromStream() {
			return Promise.resolve({ stop: vi.fn() });
		}
	},
}));

import { MobilePairing } from "@/components/mobile/mobile-pairing";
import { MobileSyncPanel } from "@/components/mobile/mobile-sync-panel";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let mediaDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
	mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
	});
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	state.done.mockClear();
	state.close.mockClear();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	if (mediaDescriptor)
		Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
	else Reflect.deleteProperty(navigator, "mediaDevices");
	vi.unstubAllGlobals();
});

function button(label: string) {
	const target = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(element) =>
			element.getAttribute("aria-label") === label ||
			element.textContent === label,
	);
	expect(target, label).toBeDefined();
	return target;
}

describe("mobile safe-area ownership", () => {
	it("keeps all four browser insets and visual gutters on the shared viewport host", () => {
		// DOM engines do not lay out env()/max(). Inspect the CSS contract;
		// physical bar/keyboard geometry is explicitly a separate device check.
		const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
		const rootRule =
			css.match(/:root\s*\{([^}]*--mobile-safe-top[^}]*)\}/)?.[1] ?? "";
		const hostRule = css.match(/\.mobile-safe-area\s*\{([^}]*)\}/)?.[1] ?? "";
		const declarations = new CSSStyleSheet();
		declarations.replaceSync(
			`:root { ${rootRule} } .mobile-safe-area { ${hostRule} }`,
		);
		const safeVariables = (declarations.cssRules[0] as CSSStyleRule).style;
		const safePadding = (declarations.cssRules[1] as CSSStyleRule).style;
		for (const edge of ["top", "right", "bottom", "left"]) {
			expect(
				safeVariables
					.getPropertyValue(`--mobile-safe-${edge}`)
					.replace(/\s/g, ""),
			).toBe(`env(safe-area-inset-${edge},0px)`);
			expect(hostRule.replace(/\s/g, "")).toContain(
				`padding-${edge}:max(var(--mobile-safe-gutter-${edge},0px),var(--mobile-safe-${edge}))`,
			);
		}
		expect(safePadding.boxSizing).toBe("border-box");
	});

	it("gives pairing and its full-screen scanner independent safe hosts without inner double insets", async () => {
		await act(async () => {
			root.render(
				createElement(MobilePairing, {
					status: { paired: false, connected: false },
					pending: null,
					initialOffer: null,
					onStatus: vi.fn(),
					onDone: state.done,
				}),
			);
		});
		const pairing = host.querySelector(".mobile-safe-area");
		expect(pairing).not.toBeNull();
		expect(pairing?.querySelector(".mobile-safe-area")).toBeNull();
		await act(() => button("connect.camera")?.click());
		const scanner = document.querySelector(
			'[role="dialog"][aria-label="connect.camera"]',
		);
		expect(scanner?.classList.contains("mobile-safe-area")).toBe(true);
		expect(scanner?.querySelector(".mobile-safe-area")).toBeNull();
		const cancel = scanner?.querySelector<HTMLButtonElement>(
			'[aria-label="connect.cancel"]',
		);
		await act(() => cancel?.click());
		expect(
			document.querySelector('[aria-label="connect.camera"][role="dialog"]'),
		).toBeNull();
		await act(() => button("connect.cancel")?.click());
		expect(state.done).toHaveBeenCalledOnce();
	});

	it("puts sync close controls and final scroll actions inside one safe portal host", async () => {
		await act(async () => {
			root.render(
				createElement(MobileSyncPanel, {
					open: true,
					vaultPath: "/private/Vault",
					onOpenChange: state.close,
					onSynced: vi.fn(),
				}),
			);
		});
		const close = button("sync.close");
		const last = button("last-download-action");
		const safeHost = close?.closest(".mobile-safe-area");
		expect(safeHost).not.toBeNull();
		expect(last?.closest(".mobile-safe-area")).toBe(safeHost);
		expect(safeHost?.querySelector(".mobile-safe-area")).toBeNull();
		await act(() => close?.click());
		expect(state.close).toHaveBeenCalledWith(false);
	});
});
