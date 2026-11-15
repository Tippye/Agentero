import { X } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/core/utils";

type Point = { x: number; y: number };
type Gesture =
	| { kind: "pan"; id: number; start: Point; origin: Point }
	| {
			kind: "pinch";
			ids: [number, number];
			startDistance: number;
			startScale: number;
	  };

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const MIN_SCALE = 1;
const MAX_SCALE = 5;

/**
 * Full-screen crop viewer with its own pinch/pan. WebView page zoom is disabled
 * (otherwise the shell itself scales and cannot reset), so this component owns
 * all image zooming.
 */
export function PdfFigureLightbox({
	src,
	title,
	onClose,
}: {
	src: string;
	title: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("viewer");
	const hostRef = useRef<HTMLDivElement>(null);
	const pointers = useRef(new Map<number, Point>());
	const gesture = useRef<Gesture | null>(null);
	const moved = useRef(false);
	const [scale, setScale] = useState(1);
	const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
	const scaleRef = useRef(scale);
	const offsetRef = useRef(offset);
	scaleRef.current = scale;
	offsetRef.current = offset;

	const clampOffset = useCallback((next: Point, nextScale: number) => {
		const host = hostRef.current;
		if (!host) return next;
		const maxX = (host.clientWidth * (nextScale - 1)) / 2;
		const maxY = (host.clientHeight * (nextScale - 1)) / 2;
		return {
			x: Math.max(-maxX, Math.min(maxX, next.x)),
			y: Math.max(-maxY, Math.min(maxY, next.y)),
		};
	}, []);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if ((event.target as Element).closest("[data-lightbox-close]")) return;
			pointers.current.set(event.pointerId, {
				x: event.clientX,
				y: event.clientY,
			});
			hostRef.current?.setPointerCapture?.(event.pointerId);
			moved.current = false;
			if (pointers.current.size === 2) {
				const [a, b] = [...pointers.current.values()] as [Point, Point];
				gesture.current = {
					kind: "pinch",
					ids: [...pointers.current.keys()] as [number, number],
					startDistance: Math.max(distance(a, b), 1),
					startScale: scaleRef.current,
				};
			} else if (pointers.current.size === 1) {
				gesture.current = {
					kind: "pan",
					id: event.pointerId,
					start: { x: event.clientX, y: event.clientY },
					origin: offsetRef.current,
				};
			}
		},
		[],
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!pointers.current.has(event.pointerId)) return;
			pointers.current.set(event.pointerId, {
				x: event.clientX,
				y: event.clientY,
			});
			const current = gesture.current;
			if (!current) return;
			if (current.kind === "pinch" && pointers.current.size >= 2) {
				const a = pointers.current.get(current.ids[0]);
				const b = pointers.current.get(current.ids[1]);
				if (!a || !b) return;
				const nextScale = Math.max(
					MIN_SCALE,
					Math.min(
						MAX_SCALE,
						(current.startScale * distance(a, b)) / current.startDistance,
					),
				);
				setScale(nextScale);
				setOffset((value) => clampOffset(value, nextScale));
				moved.current = true;
				return;
			}
			if (current.kind === "pan" && current.id === event.pointerId) {
				const dx = event.clientX - current.start.x;
				const dy = event.clientY - current.start.y;
				if (Math.hypot(dx, dy) > 4) moved.current = true;
				if (scaleRef.current > MIN_SCALE) {
					setOffset(
						clampOffset(
							{ x: current.origin.x + dx, y: current.origin.y + dy },
							scaleRef.current,
						),
					);
				}
			}
		},
		[clampOffset],
	);

	const finish = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			pointers.current.delete(event.pointerId);
			if (pointers.current.size === 1) {
				const remaining = pointers.current.entries().next().value as
					| [number, Point]
					| undefined;
				if (remaining) {
					gesture.current = {
						kind: "pan",
						id: remaining[0],
						start: remaining[1],
						origin: offsetRef.current,
					};
				}
				return;
			}
			gesture.current = null;
			if (!moved.current) onClose();
		},
		[onClose],
	);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const transform = useMemo(
		() => `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
		[offset, scale],
	);

	return createPortal(
		<div
			ref={hostRef}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			className="fixed inset-0 z-[80] flex touch-none select-none items-center justify-center overflow-hidden bg-black/85 p-4"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={finish}
			onPointerCancel={finish}
		>
			<img
				src={src}
				alt={title}
				draggable={false}
				className={cn(
					"max-h-full max-w-full origin-center object-contain shadow-2xl",
					scale > 1 && "cursor-grab active:cursor-grabbing",
				)}
				style={{ transform }}
			/>
			<div className="pointer-events-none absolute top-[calc(env(safe-area-inset-top,0px)+0.75rem)] left-1/2 max-w-[calc(100vw-8rem)] -translate-x-1/2 truncate rounded-md bg-black/55 px-3 py-1 text-sm text-white">
				{title}
			</div>
			<Button
				type="button"
				data-lightbox-close
				variant="secondary"
				size="icon"
				className="absolute top-[calc(env(safe-area-inset-top,0px)+0.75rem)] right-3 size-11 rounded-full"
				aria-label={t("pdf.close")}
				onClick={onClose}
			>
				<X className="size-5" />
			</Button>
		</div>,
		document.body,
	);
}
