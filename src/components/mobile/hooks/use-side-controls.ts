import { useEffect, useState } from "react";

/** A side-control strip exists when one horizontal safe-area inset is much
 * larger than the other: iPhone Duo reserves its status bar, Dynamic Island and
 * side toolbars along one edge, while ordinary phones are symmetric.
 * See Apple HIG "Designing for iPhone Duo" (Vertical controls). */
const MIN_SIDE_INSET = 60;

function readInsets(probe: HTMLElement) {
	const style = getComputedStyle(probe);
	return {
		left: Number.parseFloat(style.paddingLeft) || 0,
		right: Number.parseFloat(style.paddingRight) || 0,
	};
}

export type SideControlsSide = "left" | "right";

/** The edge that carries the reserved vertical control strip, if any: toolbars
 * and navigation sit on that side instead of the top. Split View on the inner
 * display keeps the strip on each app's outer edge, so the left app gets
 * `"left"` and the right app `"right"`. */
export function useSideControls(): SideControlsSide | null {
	const [side, setSide] = useState<SideControlsSide | null>(null);
	useEffect(() => {
		const probe = document.createElement("div");
		probe.setAttribute("aria-hidden", "true");
		probe.style.cssText =
			"position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
			"padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);";
		document.body.appendChild(probe);
		const measure = () => {
			const { left, right } = readInsets(probe);
			setSide(
				Math.abs(right - left) < MIN_SIDE_INSET
					? null
					: right > left
						? "right"
						: "left",
			);
		};
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("orientationchange", measure);
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("orientationchange", measure);
			probe.remove();
		};
	}, []);
	return side;
}
