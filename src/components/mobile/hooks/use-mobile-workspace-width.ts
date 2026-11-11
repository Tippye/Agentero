import { useEffect, useRef, useState } from "react";
import { mobileWorkspaceWidth } from "@/lib/mobile/workspace";

/** Observe the application container, including split-screen window changes. */
export function useMobileWorkspaceWidth<T extends HTMLElement>(enabled = true) {
	const ref = useRef<T>(null);
	const [widthClass, setWidthClass] = useState(() => mobileWorkspaceWidth(0));
	useEffect(() => {
		const element = ref.current;
		if (!enabled || !element) return;
		const measure = () =>
			setWidthClass(
				mobileWorkspaceWidth(element.getBoundingClientRect().width),
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [enabled]);
	return { ref, widthClass };
}
