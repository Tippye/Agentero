import { useLayoutEffect, useState } from "react";
import { hasMobileBackLayer } from "@/lib/mobile/back";

/** A late portalled dialog can open even while the app is at its clean root.
 * Observe public overlay attributes only while route state does not already own
 * Back. Do not observe PDF/ink updates while a document is open.
 */
export function useMobileBackLayer(watch: boolean): boolean {
	const [present, setPresent] = useState(false);
	useLayoutEffect(() => {
		if (!watch) {
			setPresent(false);
			return;
		}
		const refresh = () => setPresent(hasMobileBackLayer());
		const observer = new MutationObserver(refresh);
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [
				"data-state",
				"data-open",
				"data-closed",
				"hidden",
				"inert",
				"aria-hidden",
			],
		});
		refresh();
		return () => observer.disconnect();
	}, [watch]);
	return watch && present;
}
