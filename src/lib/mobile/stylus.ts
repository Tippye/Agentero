import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
	commands,
	type StylusActionEvent,
	type StylusPresence,
	type StylusPresenceEvent,
	type StylusState,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

export type {
	StylusAction,
	StylusActionEvent,
	StylusAdapterCapability,
	StylusPresence,
	StylusSource,
	StylusState,
} from "@/lib/core/bindings";

const actions = new Set<(event: StylusActionEvent) => void>();
const presences = new Set<(presence: StylusPresence) => void>();
let target: { token: string; documentKey: string } | null = null;
let listening: Promise<void> | null = null;
let unlisten: UnlistenFn[] = [];
let sequence: Promise<void> = Promise.resolve();

function visible(): boolean {
	return (
		typeof document === "undefined" || document.visibilityState === "visible"
	);
}
function needed(): boolean {
	return target !== null || actions.size > 0 || presences.size > 0;
}
function disposeIfIdle() {
	if (needed() || unlisten.length === 0) return;
	for (const stop of unlisten) stop();
	unlisten = [];
	listening = null;
}
async function ensureListening(): Promise<void> {
	if (!isTauri() || listening) return listening ?? Promise.resolve();
	listening = (async () => {
		const pending: UnlistenFn[] = [];
		try {
			pending.push(
				await listen<StylusActionEvent>(
					"mobile:stylus-action",
					({ payload }) => {
						if (visible() && target?.token === payload.targetToken)
							for (const listener of actions) listener(payload);
					},
				),
			);
			pending.push(
				await listen<StylusPresenceEvent>(
					"mobile:stylus-presence",
					({ payload }) => {
						if (visible() && target?.token === payload.targetToken)
							for (const listener of presences) listener(payload.presence);
					},
				),
			);
			unlisten = pending;
			disposeIfIdle();
		} catch (error) {
			for (const stop of pending) stop();
			listening = null;
			throw error;
		}
	})();
	return listening;
}
function enqueue(operation: () => Promise<void>) {
	sequence = sequence.then(operation, operation).catch(() => {
		/* No raw/native fallback on unavailable adapters. */
	});
}

export function getMobileStylusState(): Promise<StylusState> {
	if (!isTauri()) return Promise.resolve({ adapters: [], presence: [] });
	return callApiResult(() => commands.mobileStylusGetState());
}

export function isStylusTarget(documentKey: string): boolean {
	return target?.documentKey === documentKey && visible();
}

/** Call only for the active visible PDF. Cleanup invalidates its token immediately. */
export function activateStylusTarget(documentKey: string): () => void {
	const admitted = { token: crypto.randomUUID(), documentKey };
	target = admitted;
	if (isTauri())
		enqueue(async () => {
			await ensureListening();
			if (target !== admitted || !visible()) return;
			const state = await callApiResult(() =>
				commands.mobileStylusSetTarget(admitted.token, true),
			);
			if (target === admitted && visible())
				for (const presence of state.presence)
					for (const listener of presences) listener(presence);
		});
	return () => {
		if (target === admitted) target = null;
		if (isTauri())
			enqueue(async () => {
				try {
					await callApiResult(() =>
						commands.mobileStylusSetTarget(admitted.token, false),
					);
				} finally {
					disposeIfIdle();
				}
			});
		else disposeIfIdle();
	};
}

export function subscribeStylusActions(
	listener: (event: StylusActionEvent) => void,
): () => void {
	actions.add(listener);
	void ensureListening().catch(() => {});
	return () => {
		actions.delete(listener);
		disposeIfIdle();
	};
}
export function subscribeStylusPresence(
	listener: (presence: StylusPresence) => void,
): () => void {
	presences.add(listener);
	void ensureListening().catch(() => {});
	return () => {
		presences.delete(listener);
		disposeIfIdle();
	};
}

/** Pointer observation is not a persistent hardware connection or native gesture probe. */
export function observeStylusPointerPresence(proximity: boolean | null): void {
	if (!target || !visible()) return;
	const presence: StylusPresence = {
		available: true,
		proximity,
		source: "pointer",
		adapterId: "web-pointer",
	};
	for (const listener of presences) listener(presence);
}
