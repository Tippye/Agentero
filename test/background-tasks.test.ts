import { afterEach, describe, expect, it, vi } from "vitest";
import {
	backgroundTasksStore,
	clearFinishedBackgroundTasks,
	completeBackgroundTask,
	dismissBackgroundTask,
	failBackgroundTask,
	mapDownloadProgress,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";

describe("background task download progress", () => {
	it("passes the Host-merged byte progress through", () => {
		// PDF and TeX download concurrently and the Host sums their bytes, so
		// a finished TeX stream must not pin the shared row at 100%.
		expect(mapDownloadProgress("assets", 0)).toBe(0);
		expect(mapDownloadProgress("assets", 60)).toBe(60);
		expect(mapDownloadProgress("assets", 100)).toBe(100);
		expect(mapDownloadProgress("pdf", 80)).toBe(80);
		expect(mapDownloadProgress("tex", 100)).toBe(100);
		expect(mapDownloadProgress("assets", null)).toBeNull();
		expect(mapDownloadProgress("parse", null)).toBe(90);
	});

	it("clamps out-of-range byte progress", () => {
		expect(mapDownloadProgress("assets", 140)).toBe(100);
		expect(mapDownloadProgress("assets", -20)).toBe(0);
	});

	it("never regresses a task when a late phase event arrives", () => {
		const id = startBackgroundTask({
			kind: "downloadAssets",
			title: "test",
			progress: 40,
		});

		updateBackgroundTask(id, { progress: 20 });

		expect(
			backgroundTasksStore.getState().tasks.find((task) => task.id === id)
				?.progress,
		).toBe(40);

		backgroundTasksStore.setState({ tasks: [], expanded: false });
	});

	it("keeps a finished task until it is cleared", () => {
		vi.useFakeTimers();
		const id = startBackgroundTask({
			kind: "layoutAnalyze",
			title: "parse",
		});
		completeBackgroundTask(id);
		vi.advanceTimersByTime(10_000);
		expect(
			backgroundTasksStore.getState().tasks.find((task) => task.id === id)
				?.status,
		).toBe("completed");
		clearFinishedBackgroundTasks();
		expect(
			backgroundTasksStore.getState().tasks.find((task) => task.id === id),
		).toBeUndefined();
	});
});

describe("stale failure notifications", () => {
	const tasks = () => backgroundTasksStore.getState().tasks;
	const find = (id: string) => tasks().find((task) => task.id === id);

	it("retires a paper's earlier failure when a same-kind retry starts", () => {
		const failed = startBackgroundTask({
			kind: "layoutTranslate",
			title: "Translate full text",
			paperPath: "papers/a",
		});
		failBackgroundTask(failed, "Could not reach the translation service");
		const retry = startBackgroundTask({
			kind: "layoutTranslate",
			title: "Translate full text",
			paperPath: "papers/a",
		});
		expect(find(failed)).toBeUndefined();
		expect(find(retry)?.status).toBe("running");
	});

	it("retires a paper's earlier failure when the same kind completes", () => {
		const failed = startBackgroundTask({
			kind: "layoutTranslate",
			title: "Translate full text",
			paperPath: "papers/a",
		});
		failBackgroundTask(failed, "Could not reach the translation service");
		const done = startBackgroundTask({
			kind: "layoutTranslate",
			title: "Translate full text",
			paperPath: "papers/a",
		});
		completeBackgroundTask(done);
		expect(find(failed)).toBeUndefined();
		expect(find(done)?.status).toBe("completed");
	});

	it("keeps failures scoped to other papers or other kinds", () => {
		const otherPaper = startBackgroundTask({
			kind: "layoutTranslate",
			title: "Translate full text",
			paperPath: "papers/b",
		});
		failBackgroundTask(otherPaper, "unreachable");
		const otherKind = startBackgroundTask({
			kind: "layoutAnalyze",
			title: "Analyze",
			paperPath: "papers/a",
		});
		failBackgroundTask(otherKind, "model missing");
		const retry = startBackgroundTask({
			kind: "layoutTranslate",
			title: "Translate full text",
			paperPath: "papers/a",
		});
		completeBackgroundTask(retry);
		expect(find(otherPaper)?.status).toBe("failed");
		expect(find(otherKind)?.status).toBe("failed");
	});

	it("dismisses one finished row manually without touching active rows", () => {
		const failed = startBackgroundTask({
			kind: "layoutTranslate",
			title: "Translate full text",
			paperPath: "papers/a",
		});
		failBackgroundTask(failed, "unreachable");
		const active = startBackgroundTask({
			kind: "layoutAnalyze",
			title: "Analyze",
			paperPath: "papers/a",
		});
		dismissBackgroundTask(failed);
		expect(find(failed)).toBeUndefined();
		expect(find(active)?.status).toBe("running");
		// Active rows cannot be dismissed.
		dismissBackgroundTask(active);
		expect(find(active)?.status).toBe("running");
	});
});

afterEach(() => {
	vi.useRealTimers();
	backgroundTasksStore.setState({ tasks: [], expanded: false });
});
