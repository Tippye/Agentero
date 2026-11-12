// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	t: (key: string) => key,
	decode: vi.fn(),
	getMedia: vi.fn(),
	trackStop: vi.fn(),
	stop: vi.fn(),
	outer: vi.fn(),
	done: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: io.t }) }));
vi.mock("@/lib/bridge/client", () => ({
	bridgeConnect: vi.fn(),
	listenBridgeProgress: vi.fn(async () => () => {}),
}));
vi.mock("@/components/mobile/mobile-bridge-reset", () => ({
	MobileBridgeReset: () => null,
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@zxing/browser", () => ({
	BrowserQRCodeReader: class {
		decodeFromStream(...args: unknown[]) {
			return io.decode(...args);
		}
	},
}));

import { MobilePairing } from "@/components/mobile/mobile-pairing";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { dismissMobileBackLayer } from "@/lib/mobile/back";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let mediaDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
	mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: io.getMedia },
	});
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	io.decode.mockResolvedValue({ stop: io.stop });
	io.getMedia.mockResolvedValue({ getTracks: () => [{ stop: io.trackStop }] });
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
async function back() {
	let handled = false;
	await act(() => {
		handled = dismissMobileBackLayer();
	});
	return handled;
}
async function click(label: string) {
	const target = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent === label);
	expect(target).toBeDefined();
	await act(() => target?.click());
}
function PairingHost({ onDone = io.done }: { onDone?: () => void } = {}) {
	const [open, setOpen] = useState(true);
	return h(
		Dialog,
		{
			open,
			onOpenChange: (next: boolean) => {
				io.outer(next);
				setOpen(next);
			},
		},
		h(
			DialogContent,
			{ "aria-describedby": undefined },
			h(DialogTitle, null, "Outer pairing"),
			h(MobilePairing, {
				status: { paired: false, connected: false },
				pending: null,
				initialOffer: null,
				onStatus: vi.fn(),
				onDone,
			}),
		),
	);
}
describe("Android back uses managed overlay dismissal", () => {
	it("stops a camera acquired after scanner dismissal before handing it to the decoder", async () => {
		let acquire: (stream: { getTracks: () => { stop: () => void }[] }) => void =
			() => {};
		io.getMedia.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					acquire = resolve;
				}),
		);
		await act(() => root.render(h(PairingHost)));
		await click("connect.camera");
		expect(io.getMedia).toHaveBeenCalledOnce();
		expect(io.decode).not.toHaveBeenCalled();
		expect(await back()).toBe(true);
		await act(async () =>
			acquire({ getTracks: () => [{ stop: io.trackStop }] }),
		);
		expect(io.trackStop).toHaveBeenCalledOnce();
		expect(io.decode).not.toHaveBeenCalled();
		expect(io.done).not.toHaveBeenCalled();
	});
	it("keeps one camera acquisition across parent renders and uses the latest scan callback", async () => {
		const firstDone = vi.fn(),
			lastDone = vi.fn();
		await act(() => root.render(h(PairingHost, { onDone: firstDone })));
		await click("connect.camera");
		await act(() => root.render(h(PairingHost, { onDone: lastDone })));
		expect(io.getMedia).toHaveBeenCalledOnce();
		expect(io.decode).toHaveBeenCalledOnce();
		const scan = io.decode.mock.calls[0][2] as (
			result: { getText: () => string },
			error: null,
			controls: { stop: () => void },
		) => void;
		await act(async () =>
			scan({ getText: () => "fixture-offer" }, null, { stop: io.stop }),
		);
		expect(firstDone).not.toHaveBeenCalled();
		expect(lastDone).toHaveBeenCalledOnce();
		expect(io.trackStop).toHaveBeenCalled();
	});
	it("closes the nested scanner first and releases its acquired stream before decoder startup finishes", async () => {
		let finish: (value: { stop: () => void }) => void = () => {};
		io.decode.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await act(() => root.render(h(PairingHost)));
		await click("connect.camera");
		expect(io.decode).toHaveBeenCalledOnce();
		expect(
			document.querySelectorAll('[role="dialog"][data-state="open"]'),
		).toHaveLength(2);
		expect(await back()).toBe(true);
		expect(
			document.querySelector('[aria-label="connect.camera"][role="dialog"]'),
		).toBeNull();
		expect(io.outer).not.toHaveBeenCalled();
		expect(io.done).not.toHaveBeenCalled();
		expect(io.trackStop).toHaveBeenCalledOnce();
		expect(io.stop).not.toHaveBeenCalled();
		await act(async () => finish({ stop: io.stop }));
		expect(io.stop).toHaveBeenCalledOnce();
		expect(await back()).toBe(true);
		expect(io.outer).toHaveBeenCalledWith(false);
		expect(await back()).toBe(false);
	});
	it("closes manual pairing before its containing pairing dialog", async () => {
		await act(() => root.render(h(PairingHost)));
		await click("connect.manual");
		expect(
			document.querySelectorAll('[role="dialog"][data-state="open"]'),
		).toHaveLength(2);
		expect(await back()).toBe(true);
		expect(io.outer).not.toHaveBeenCalled();
		expect(
			document.querySelectorAll('[role="dialog"][data-state="open"]'),
		).toHaveLength(1);
		expect(await back()).toBe(true);
		expect(io.outer).toHaveBeenCalledWith(false);
	});
	it("consumes Back when a dialog's public dismissal guard refuses it", async () => {
		await act(() =>
			root.render(
				h(
					Dialog,
					{ open: true, onOpenChange: io.outer },
					h(
						DialogContent,
						{
							"aria-describedby": undefined,
							onEscapeKeyDown: (event: KeyboardEvent) => event.preventDefault(),
						},
						h(DialogTitle, null, "Busy operation"),
					),
				),
			),
		);
		expect(await back()).toBe(true);
		expect(io.outer).not.toHaveBeenCalled();
		expect(
			document.querySelector('[role="dialog"][data-state="open"]'),
		).not.toBeNull();
	});
	it("ignores closed, hidden, and inert layers instead of trapping the library root", () => {
		host.innerHTML =
			'<section inert><div role="dialog" data-state="open"></div></section><div role="dialog" data-state="closed"></div><div hidden role="dialog" data-state="open"></div>';
		expect(dismissMobileBackLayer()).toBe(false);
	});
});
