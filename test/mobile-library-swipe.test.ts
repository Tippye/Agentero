// @vitest-environment happy-dom

import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileLibraryPage } from "@/components/mobile/mobile-library-page";
import type { PaperMetadata } from "@/lib/paper/types";

const translate = vi.hoisted(() =>
	vi.fn((key: string, _options?: Record<string, unknown>) => key),
);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));

type LibraryProps = ComponentProps<typeof MobileLibraryPage>;

function paper(id: string): PaperMetadata {
	return {
		id,
		path: `papers/${id}`,
		type: "pdf",
		title: `Title ${id}`,
		authors: ["Ada Lovelace"],
		tags: [],
		status: "completed",
		is_read: false,
		added_at: "2026-11-01",
		updated_at: "2026-11-01",
	};
}

const first = paper("first");
const second = paper("second");

const onSelect = vi.fn();
const onPinChange = vi.fn();
const onDeletePaper = vi.fn(async () => {});
const syncStates = { first: { pinned: false, offline: false, busy: false } };

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

/** happy-dom has no Touch/TouchEvent; native events with touch lists are enough. */
function touchEvent(type: string, x: number, y: number) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const touch = { clientX: x, clientY: y };
	const ended = type === "touchend" || type === "touchcancel";
	Object.defineProperty(event, "touches", { value: ended ? [] : [touch] });
	Object.defineProperty(event, "changedTouches", { value: [touch] });
	return event;
}

async function dispatchTouch(
	target: Element,
	type: string,
	x: number,
	y: number,
) {
	await act(async () => {
		target.dispatchEvent(touchEvent(type, x, y));
	});
}

async function swipe(
	target: Element,
	fromX: number,
	toX: number,
	fromY = 120,
	toY = 120,
) {
	await dispatchTouch(target, "touchstart", fromX, fromY);
	await dispatchTouch(target, "touchmove", toX, toY);
	await dispatchTouch(target, "touchend", toX, toY);
}

function rows() {
	return [...container.querySelectorAll<HTMLLIElement>("li")];
}
function content(row: Element) {
	const element = row.querySelector<HTMLElement>("[data-swipe-content]");
	expect(element).not.toBeNull();
	return element as HTMLElement;
}
function transform(row: Element) {
	return content(row).style.transform;
}
function selectButton(row: Element) {
	const button = row.querySelector<HTMLButtonElement>(
		"[data-swipe-content] > button",
	);
	expect(button).not.toBeNull();
	return button as HTMLButtonElement;
}
function deleteButton(row: Element) {
	const button = row.querySelector<HTMLButtonElement>(
		'button[aria-label="library.deletePaper"]',
	);
	expect(button).not.toBeNull();
	return button as HTMLButtonElement;
}
function dialog() {
	return document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
}
function dialogButton(label: string) {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((element) => element.textContent?.trim() === label);
	expect(button, label).toBeDefined();
	return button as HTMLButtonElement;
}

async function render(overrides: Partial<LibraryProps> = {}) {
	await act(async () => {
		root.render(
			createElement(MobileLibraryPage, {
				papers: [first, second],
				loading: false,
				selected: null,
				onSelect,
				query: "",
				onDeletePaper,
				...overrides,
			}),
		);
	});
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	onDeletePaper.mockResolvedValue(undefined);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await render();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("mobile library row actions", () => {
	it("reveals a focusable delete action after a left swipe and snaps with a transition", async () => {
		const row = rows()[0];
		expect(transform(row)).toBe("translateX(0px)");
		expect(deleteButton(row).tabIndex).toBe(-1);

		await dispatchTouch(selectButton(row), "touchstart", 200, 120);
		await dispatchTouch(selectButton(row), "touchmove", 120, 120);
		expect(transform(row)).toBe("translateX(-72px)");
		expect(content(row).style.transition).toBe("none");

		await dispatchTouch(selectButton(row), "touchend", 120, 120);
		expect(transform(row)).toBe("translateX(-72px)");
		expect(content(row).style.transition).toContain("transform 150ms");
		const action = deleteButton(row);
		expect(action.tabIndex).toBe(0);
		expect(action.disabled).toBe(false);
		await act(async () => action.focus());
		expect(document.activeElement).toBe(action);
	});

	it("does not open on a right swipe, a vertical drag, or an ambiguous diagonal", async () => {
		const row = rows()[0];

		await swipe(selectButton(row), 120, 200);
		expect(transform(row)).toBe("translateX(0px)");
		expect(deleteButton(row).tabIndex).toBe(-1);

		await swipe(selectButton(row), 200, 202, 200, 320);
		expect(transform(row)).toBe("translateX(0px)");
		expect(deleteButton(row).tabIndex).toBe(-1);

		await swipe(selectButton(row), 200, 230, 120, 170);
		expect(transform(row)).toBe("translateX(0px)");
		expect(deleteButton(row).tabIndex).toBe(-1);
	});

	it("keeps only one row open when another row starts swiping", async () => {
		const [firstRow, secondRow] = rows();
		await swipe(selectButton(firstRow), 200, 100);
		expect(transform(firstRow)).toBe("translateX(-72px)");

		await swipe(selectButton(secondRow), 200, 100);
		expect(transform(firstRow)).toBe("translateX(0px)");
		expect(transform(secondRow)).toBe("translateX(-72px)");
		expect(deleteButton(firstRow).tabIndex).toBe(-1);
		expect(deleteButton(secondRow).tabIndex).toBe(0);
	});

	it("closes an open row when its content is tapped without selecting the paper", async () => {
		const row = rows()[0];
		await swipe(selectButton(row), 200, 100);
		expect(transform(row)).toBe("translateX(-72px)");

		const button = selectButton(row);
		await dispatchTouch(button, "touchstart", 160, 120);
		await dispatchTouch(button, "touchend", 160, 120);
		await act(async () => button.click());

		expect(onSelect).not.toHaveBeenCalled();
		expect(transform(row)).toBe("translateX(0px)");
	});

	it("confirms deletion once, waits for the owner, and closes the dialog and row", async () => {
		let resolveDelete: () => void = () => {};
		onDeletePaper.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveDelete = resolve;
				}),
		);
		const row = rows()[0];
		await swipe(selectButton(row), 200, 100);
		await act(async () => deleteButton(row).click());

		const title = document.querySelector('[data-slot="dialog-title"]');
		expect(title?.textContent).toBe("library.deletePaperTitle");
		const description = document.querySelector(
			'[data-slot="dialog-description"]',
		);
		expect(description?.textContent).toBe("library.deletePaperDescription");
		expect(translate).toHaveBeenCalledWith("library.deletePaperDescription", {
			title: "Title first",
		});

		const confirm = dialogButton("library.deletePaperConfirm");
		const cancel = dialogButton("common:cancel");
		await act(async () => confirm.click());

		expect(onDeletePaper).toHaveBeenCalledTimes(1);
		expect(onDeletePaper).toHaveBeenCalledWith(first);
		expect(confirm.disabled).toBe(true);
		expect(cancel.disabled).toBe(true);
		expect(deleteButton(row).disabled).toBe(true);
		expect(dialog()).not.toBeNull();

		await act(async () => {
			resolveDelete();
		});
		expect(onDeletePaper).toHaveBeenCalledTimes(1);
		expect(dialog()).toBeNull();
		expect(transform(row)).toBe("translateX(0px)");
	});

	it("cancels deletion without calling the owner", async () => {
		const row = rows()[0];
		await swipe(selectButton(row), 200, 100);
		await act(async () => deleteButton(row).click());
		expect(dialog()).not.toBeNull();

		await act(async () => dialogButton("common:cancel").click());
		expect(onDeletePaper).not.toHaveBeenCalled();
		expect(dialog()).toBeNull();
		expect(transform(row)).toBe("translateX(-72px)");
	});

	it("keeps the dialog and row retryable when the owner rejects", async () => {
		onDeletePaper.mockRejectedValueOnce(new Error("trash unavailable"));
		const row = rows()[0];
		await swipe(selectButton(row), 200, 100);
		await act(async () => deleteButton(row).click());
		const confirm = dialogButton("library.deletePaperConfirm");

		await act(async () => confirm.click());

		expect(onDeletePaper).toHaveBeenCalledTimes(1);
		expect(dialog()).not.toBeNull();
		expect(confirm.disabled).toBe(false);
		expect(deleteButton(row).disabled).toBe(false);
		expect(transform(row)).toBe("translateX(-72px)");
	});

	it("keeps plain selection and the pin action working", async () => {
		await render({
			syncStates,
			onPinChange,
		});
		const row = rows()[0];
		await act(async () => selectButton(row).click());
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith(first);

		const pin = row.querySelector<HTMLButtonElement>('[aria-label="sync.pin"]');
		expect(pin).not.toBeNull();
		await act(async () => pin?.click());
		expect(onPinChange).toHaveBeenCalledTimes(1);
		expect(onPinChange).toHaveBeenCalledWith(first, true);
		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});
