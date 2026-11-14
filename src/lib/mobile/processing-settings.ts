export type MobileProcessingSection = "translate" | "layout";

const OPEN_EVENT = "agentero:mobile-processing-settings";

/** Open the in-shell settings dialog without creating a desktop window. */
export function openMobileProcessingSettings(
	section: MobileProcessingSection = "translate",
): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: section }));
}

export function listenMobileProcessingSettings(
	onOpen: (section: MobileProcessingSection) => void,
): () => void {
	if (typeof window === "undefined") return () => {};
	const listener = (event: Event) => {
		const section = (event as CustomEvent<unknown>).detail;
		if (section === "translate" || section === "layout") onOpen(section);
	};
	window.addEventListener(OPEN_EVENT, listener);
	return () => window.removeEventListener(OPEN_EVENT, listener);
}
