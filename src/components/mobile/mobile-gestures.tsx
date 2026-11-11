import {
	type PointerEvent,
	type ReactNode,
	type TouchEvent,
	useRef,
} from "react";

export type SwipeSummary = {
	dx: number;
	dy: number;
	fromEdge: boolean;
	durationMs: number;
};
const EDGE_WIDTH_PX = 28;

/** Observe native touch streams without cancelling scrolling, selection, or pinch.
 * Stylus streams are excluded before touch compatibility events can navigate. */
export function useHorizontalSwipe(
	onSwipe: (swipe: SwipeSummary) => void,
	disabled = false,
) {
	const pen = useRef(false);
	const stateRef = useRef<{
		x: number;
		y: number;
		t: number;
		fromEdge: boolean;
		valid: boolean;
	} | null>(null);
	const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
		pen.current = event.pointerType === "pen";
		if (pen.current) stateRef.current = null;
	};
	const onTouchStart = (event: TouchEvent<HTMLElement>) => {
		if (disabled || pen.current || event.touches.length !== 1) {
			if (stateRef.current) stateRef.current.valid = false;
			return;
		}
		const touch = event.touches[0];
		const left = event.currentTarget.getBoundingClientRect().left;
		stateRef.current = {
			x: touch.clientX,
			y: touch.clientY,
			t: event.timeStamp,
			fromEdge: touch.clientX - left <= EDGE_WIDTH_PX,
			valid: true,
		};
	};
	const onTouchMove = (event: TouchEvent<HTMLElement>) => {
		if ((disabled || event.touches.length > 1) && stateRef.current)
			stateRef.current.valid = false;
	};
	const onTouchEnd = (event: TouchEvent<HTMLElement>) => {
		const state = stateRef.current;
		if (event.touches.length > 0) return;
		stateRef.current = null;
		if (disabled || pen.current || !state?.valid) return;
		const touch = event.changedTouches[0];
		if (touch)
			onSwipe({
				dx: touch.clientX - state.x,
				dy: touch.clientY - state.y,
				fromEdge: state.fromEdge,
				durationMs: event.timeStamp - state.t,
			});
	};
	const onTouchCancel = () => {
		stateRef.current = null;
	};
	return {
		onPointerDownCapture,
		onTouchStart,
		onTouchMove,
		onTouchEnd,
		onTouchCancel,
	};
}

/** No overlay intercepts the first pen stroke or the document's native scroll.
 * A committed touch edge swipe closes only after the caller's dirty guard. */
export function EdgeSwipeBack({
	onBack,
	disabled = false,
	children,
}: {
	onBack: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	const gestures = useHorizontalSwipe(({ dx, dy, fromEdge, durationMs }) => {
		if (!fromEdge || durationMs > 800 || dx <= Math.abs(dy) * 1.25) return;
		if (dx > 90 || (dx > 35 && dx / Math.max(durationMs, 1) > 0.5)) onBack();
	}, disabled);
	return (
		<div className="h-full min-h-0" {...gestures}>
			{children}
		</div>
	);
}
