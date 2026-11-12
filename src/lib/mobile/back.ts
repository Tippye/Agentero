const OPEN_BACK_LAYERS = ["dialog", "alertdialog", "menu", "listbox"]
	.flatMap((role) => [
		`[role="${role}"][data-state="open"]`,
		`[role="${role}"][data-open]`,
	])
	.join(",");

function topMobileBackLayer(ownerDocument: Document): HTMLElement | undefined {
	return [...ownerDocument.querySelectorAll<HTMLElement>(OPEN_BACK_LAYERS)]
		.filter(
			(element) =>
				!element.closest(
					'[hidden], [inert], [aria-hidden="true"], [data-state="closed"], [data-closed]',
				),
		)
		.at(-1);
}

export function hasMobileBackLayer(
	ownerDocument: Document = document,
): boolean {
	return topMobileBackLayer(ownerDocument) !== undefined;
}

/** Map an Android back action to the UI library's normal, cancellable dismissal.
 * Public role/open attributes identify managed overlays; the library still owns
 * nesting, focus, and onOpenChange guards. A refused dismissal consumes Back.
 */
export function dismissMobileBackLayer(
	ownerDocument: Document = document,
): boolean {
	const layer = topMobileBackLayer(ownerDocument);
	if (!layer) return false;
	const KeyboardEvent = ownerDocument.defaultView?.KeyboardEvent;
	if (!KeyboardEvent) return true;
	const focused = ownerDocument.activeElement;
	const target = focused && layer.contains(focused) ? focused : layer;
	target.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Escape",
			code: "Escape",
			bubbles: true,
			cancelable: true,
			composed: true,
		}),
	);
	return true;
}
