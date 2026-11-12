// @vitest-environment happy-dom
import { MotionConfig } from "motion/react";
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";
import { dismissMobileBackLayer } from "@/lib/mobile/back";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init() {} },
	useTranslation: () => ({ t: (key: string) => key }),
}));
// Exercise the real card, motion surface, keyboard owner and Radix composition.
vi.mock("@/components/agent/message", () => ({
	MessageResponse: ({ children }: { children?: string }) => children,
}));
const hide = vi.fn(),
	readerBack = vi.fn(),
	pin = vi.fn(),
	nestedDismiss = vi.fn();
let root: Root, host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("innerWidth", 1000);
	vi.stubGlobal("innerHeight", 700);
	vi.clearAllMocks();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});
function Reader({ nested = false }: { nested?: boolean }) {
	const [translation, setTranslation] = useState(true),
		[other, setOther] = useState(nested);
	return h(
		"section",
		{ "data-reader": true },
		h("article", { "data-pdf-document": true }, "Source PDF"),
		translation
			? h(TranslateCard, {
					screen: { x: 600, y: 200 },
					result: "Translated source text",
					streaming: false,
					error: null,
					onOpenSettings() {},
					pinned: true,
					onTogglePin: pin,
					onHide: () => {
						hide();
						setTranslation(false);
					},
				})
			: null,
		other
			? h(
					Dialog,
					{
						open: true,
						onOpenChange: (open: boolean) => {
							nestedDismiss(open);
							setOther(open);
						},
					},
					h(
						DialogContent,
						{ "aria-describedby": undefined },
						h(DialogTitle, null, "Other managed dialog"),
					),
				)
			: null,
	);
}
async function renderReader(nested = false) {
	await act(async () =>
		root.render(h(MotionConfig, { isStatic: true }, h(Reader, { nested }))),
	);
}
async function back() {
	let handled = false;
	await act(() => {
		handled = dismissMobileBackLayer();
		if (!handled) readerBack();
	});
	return handled;
}
const translate = () =>
	host.querySelector<HTMLElement>(
		'[role="dialog"][aria-label="selection.translateTitle"]',
	);

it("Android Back calls the actual translation Escape owner once before the intact reader can close", async () => {
	await renderReader();
	const reader = host.querySelector("[data-reader]"),
		document = host.querySelector("[data-pdf-document]");
	expect(translate()?.getAttribute("data-state")).toBe("open");
	expect(await back()).toBe(true);
	expect(hide).toHaveBeenCalledOnce();
	expect(pin).not.toHaveBeenCalled();
	expect(readerBack).not.toHaveBeenCalled();
	expect(translate()).toBeNull();
	expect(host.querySelector("[data-reader]")).toBe(reader);
	expect(host.querySelector("[data-pdf-document]")).toBe(document);
	expect(document?.isConnected).toBe(true);
	expect(await back()).toBe(false);
	expect(readerBack).toHaveBeenCalledOnce();
	expect(hide).toHaveBeenCalledOnce();
});

it("consumes managed Back without hiding translation or reader while an editable target owns Escape", async () => {
	await renderReader();
	const card = translate();
	if (!card) throw Error("Missing translation card");
	const editor = document.createElement("textarea");
	card.append(editor);
	editor.focus();
	expect(await back()).toBe(true);
	expect(hide).not.toHaveBeenCalled();
	expect(readerBack).not.toHaveBeenCalled();
	expect(translate()).toBe(card);
	expect(document.activeElement).toBe(editor);
	await act(() => {
		editor.blur();
	});
	expect(await back()).toBe(true);
	expect(hide).toHaveBeenCalledOnce();
	expect(readerBack).not.toHaveBeenCalled();
});

it("leaves another managed dialog's Escape owner first, then hides translation on the next Back", async () => {
	await renderReader(true);
	expect(
		document.querySelectorAll('[role="dialog"][data-state="open"]'),
	).toHaveLength(2);
	expect(await back()).toBe(true);
	expect(nestedDismiss).toHaveBeenCalledExactlyOnceWith(false);
	expect(hide).not.toHaveBeenCalled();
	expect(readerBack).not.toHaveBeenCalled();
	expect(translate()).not.toBeNull();
	expect(await back()).toBe(true);
	expect(hide).toHaveBeenCalledOnce();
	expect(readerBack).not.toHaveBeenCalled();
});

it("keeps passive selection cards unmarked instead of trapping native Back", async () => {
	const props: Parameters<typeof SelectionCard>[0] = {
		screen: { x: 300, y: 150 },
		title: "Passive PDF preview",
		children: "Passive preview content",
		"data-state": undefined,
	};
	await act(async () =>
		root.render(h(MotionConfig, { isStatic: true }, h(SelectionCard, props))),
	);
	const card = host.querySelector('[role="dialog"]');
	expect(card).not.toBeNull();
	expect(card?.hasAttribute("data-state")).toBe(false);
	expect(card?.hasAttribute("data-open")).toBe(false);
	expect(await back()).toBe(false);
	expect(readerBack).toHaveBeenCalledOnce();
});

it.each([
	false,
	true,
])("preserves Radix asChild's open marker when the optional state is omitted/undefined (%s)", async (explicitUndefined) => {
	const dismissed = vi.fn();
	const props: Parameters<typeof SelectionCard>[0] = {
		screen: { x: 300, y: 150 },
		title: "Dismissible PDF card",
		children: "Card body",
		onDismiss: dismissed,
		...(explicitUndefined ? { "data-state": undefined } : {}),
	};
	await act(async () =>
		root.render(h(MotionConfig, { isStatic: true }, h(SelectionCard, props))),
	);
	expect(
		host.querySelector('[role="dialog"]')?.getAttribute("data-state"),
	).toBe("open");
	expect(await back()).toBe(true);
	expect(dismissed).toHaveBeenCalledOnce();
	expect(readerBack).not.toHaveBeenCalled();
});
