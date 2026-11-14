// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { MobileTaskIndicator } from "@/components/mobile/mobile-task-indicator";
import {
	backgroundTasksStore,
	failBackgroundTask,
	registerBackgroundTaskCancelHandler,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

async function render() {
	await act(async () => {
		root.render(createElement(MobileTaskIndicator));
	});
}

function progress(container: HTMLElement) {
	return container.querySelector('[role="progressbar"]');
}

function click(label: string) {
	const target = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(button) =>
			button.getAttribute("aria-label") === label ||
			button.textContent === label,
	);
	expect(target, label).toBeDefined();
	target?.click();
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	backgroundTasksStore.setState({ tasks: [], expanded: false });
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	backgroundTasksStore.setState({ tasks: [], expanded: false });
	vi.unstubAllGlobals();
});

describe("mobile background task indicator", () => {
	it("shows live translation progress and cancels it without opening the list", async () => {
		const cancel = vi.fn();
		const id = startBackgroundTask({
			id: "translate-job",
			kind: "layoutTranslate",
			title: "Translate paper",
			progress: 12,
		});
		registerBackgroundTaskCancelHandler(id, cancel);
		await render();
		expect(host.textContent).toContain("Translate paper");
		expect(progress(host)?.getAttribute("aria-valuenow")).toBe("12");
		expect(host.textContent).toContain("12%");

		await act(() => updateBackgroundTask(id, { progress: 57 }));
		expect(progress(host)?.getAttribute("aria-valuenow")).toBe("57");
		expect(host.textContent).toContain("57%");

		await act(() => click("tasks.cancel"));
		expect(cancel).toHaveBeenCalledOnce();
		expect(host.textContent).toBe("");
	});

	it("keeps failed translation visible with its error", async () => {
		const id = startBackgroundTask({
			id: "failed-job",
			kind: "layoutTranslate",
			title: "Translate paper",
		});
		await render();
		await act(() => failBackgroundTask(id, "request timed out"));
		expect(host.textContent).toContain("Translate paper");
		expect(host.textContent).toContain("request timed out");
		expect(host.textContent).not.toContain("tasks.cancel");
	});

	it("expands to every running task and can cancel any of them", async () => {
		const cancelFirst = vi.fn();
		const cancelSecond = vi.fn();
		const first = startBackgroundTask({
			id: "first-job",
			kind: "layoutTranslate",
			title: "Translate paper",
			progress: 20,
		});
		const second = startBackgroundTask({
			id: "second-job",
			kind: "layoutAnalyze",
			title: "Analyze figures",
			progress: null,
		});
		registerBackgroundTaskCancelHandler(first, cancelFirst);
		registerBackgroundTaskCancelHandler(second, cancelSecond);
		await render();
		expect(host.textContent).toContain("Translate paper");
		expect(host.textContent).not.toContain("Analyze figures");

		await act(() => click("tasks.show"));
		expect(host.textContent).toContain("Analyze figures");
		expect(host.textContent).toContain("20%");
		const secondCancel = host
			.querySelector('[data-task-id="second-job"]')
			?.querySelector<HTMLButtonElement>('button[aria-label="tasks.cancel"]');
		expect(secondCancel).not.toBeNull();

		await act(() => secondCancel?.click());
		expect(cancelSecond).toHaveBeenCalledOnce();
		expect(cancelFirst).not.toHaveBeenCalled();
		expect(host.textContent).not.toContain("Analyze figures");
	});
});
