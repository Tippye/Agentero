import { listen } from "@tauri-apps/api/event";
import {
	type BridgeClientStatus as ClientStatus,
	commands,
	type Json,
} from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";

// A fresh frontend may know only these flags before the first host snapshot.
export type BridgeClientStatus = Pick<ClientStatus, "connected" | "paired"> &
	Partial<Omit<ClientStatus, "connected" | "paired">>;

export type PairPendingEvent = {
	requestId: string;
	verificationCode: string;
};

export async function bridgeConnect(args: {
	offerUrl: string;
	deviceName: string;
}): Promise<BridgeClientStatus> {
	return callApi(() => commands.bridgeClientConnect(args));
}

export async function bridgeDisconnect(): Promise<void> {
	await callApi(() => commands.bridgeClientDisconnect());
}

export async function bridgeResume(): Promise<BridgeClientStatus> {
	return callApi(() => commands.bridgeClientResume());
}

export async function bridgeStatus(): Promise<BridgeClientStatus> {
	return callApi(() => commands.bridgeClientStatus());
}

export async function bridgeRpc<T>(
	method: string,
	params: Record<string, unknown> = {},
): Promise<T> {
	return (await callApiResult(() =>
		commands.bridgeClientRpc(method, params as Json),
	)) as T;
}

export async function listenBridgeStatus(
	handler: (status: BridgeClientStatus) => void,
): Promise<() => void> {
	return listen<BridgeClientStatus>("bridge:status", (event) =>
		handler(event.payload),
	);
}

export type BridgeProgressPhase =
	| "relayConnecting"
	| "e2eeHandshake"
	| "pairing"
	| "authenticating"
	| "connected";

export async function listenBridgeProgress(
	handler: (phase: BridgeProgressPhase) => void,
): Promise<() => void> {
	return listen<BridgeProgressPhase>("bridge:progress", (event) =>
		handler(event.payload),
	);
}

export async function listenPairPending(
	handler: (event: PairPendingEvent) => void,
): Promise<() => void> {
	return listen<PairPendingEvent>("bridge:pair-pending", (event) =>
		handler(event.payload),
	);
}

export async function listenBridgeEvent<T>(
	name: string,
	handler: (payload: T) => void,
): Promise<() => void> {
	return listen<T>(`bridge:event:${name}`, (event) => handler(event.payload));
}
