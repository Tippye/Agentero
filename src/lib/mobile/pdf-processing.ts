import { useEffect } from "react";
import { startTaskRuntime } from "@/lib/core/tasks";
import { registerLayoutTaskExecutor } from "@/lib/pdf/layout/enqueue-paper-layout";
import { registerLayoutTranslateTaskExecutor } from "@/lib/pdf/layout/headless-translate";
import { enterApiOnlyPdfProcessing } from "@/lib/pdf/processing-policy";

/** Mount once at the mobile shell, never at the document/reader boundary. */
export function useMobilePdfProcessingRuntime(): void {
	useEffect(() => {
		const releasePolicy = enterApiOnlyPdfProcessing();
		registerLayoutTaskExecutor({ apiOnly: true });
		registerLayoutTranslateTaskExecutor({ apiOnly: true });
		const stop = startTaskRuntime();
		return () => {
			stop();
			releasePolicy();
		};
	}, []);
}
