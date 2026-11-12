// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileAgentPage } from "@/components/mobile/mobile-agent-page";
import type {
	AcpListSessionsResult,
	AgentPermissionRequest,
} from "@/components/mobile/types";

const chat = vi.hoisted(() => ({
	state: { permission: null as AgentPermissionRequest | null },
	listeners: new Set<() => void>(),
	mounts: 0,
	cleanups: 0,
	sessions: [] as (string | null)[],
	respond: vi.fn(),
	send: vi.fn(async () => {}),
	restore: vi.fn(),
	clear: vi.fn(),
	rpc: vi.fn(),
}));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/bridge/client", () => ({
	bridgeRpc: (...args: unknown[]) => chat.rpc(...args),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/mobile/hooks/use-mobile-agent-chat", async () => {
	const { useEffect, useSyncExternalStore } = await import("react");
	return {
		useMobileAgentChat: ({ sessionId }: { sessionId: string | null }) => {
			const state = useSyncExternalStore(
				(listener) => {
					chat.listeners.add(listener);
					return () => {
						chat.listeners.delete(listener);
					};
				},
				() => chat.state,
			);
			useEffect(() => {
				chat.mounts++;
				return () => {
					chat.cleanups++;
				};
			}, []);
			chat.sessions.push(sessionId);
			return {
				lines: [
					{
						id: "retained-message",
						role: "assistant",
						text: "Retained session message",
					},
				],
				sending: false,
				restoring: false,
				phase: null,
				permission: state.permission,
				respondToPermission: chat.respond,
				send: chat.send,
				restore: chat.restore,
				clearSession: chat.clear,
			};
		},
	};
});
// Keep the real composer and Radix Dialog portals; omit only rich rendering/scroller contexts.
vi.mock("@/components/agent/conversation", () => {
	const Box = ({ children }: { children?: ReactNode }) => children;
	return {
		Conversation: Box,
		ConversationContent: Box,
		ConversationEmptyState: Box,
		ConversationScrollButton: () => null,
	};
});
vi.mock("@/components/agent/message", () => {
	const Box = ({ children }: { children?: ReactNode }) => children;
	return { Message: Box, MessageContent: Box, MessageResponse: Box };
});
vi.mock("@/components/ui/message-scroller", () => {
	const Box = ({ children }: { children?: ReactNode }) => children;
	return { MessageScrollerContent: Box, MessageScrollerItem: Box };
});
let root: Root, host: HTMLDivElement;
const historyChanged = vi.fn(),
	sessionChanged = vi.fn();
const request: AgentPermissionRequest = {
	requestId: "permission-42",
	sessionId: "session-42",
	title: "Pending permission request",
	paths: ["papers/paper/source.pdf"],
	options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
};
function publishPermission(permission: AgentPermissionRequest | null) {
	chat.state = { permission };
	for (const listener of chat.listeners) listener();
}
async function render(active: boolean | undefined, historyOpen = false) {
	await act(async () => {
		root.render(
			createElement(
				"div",
				{ hidden: active === false },
				createElement(MobileAgentPage, {
					active,
					selectedAgentId: "agent-42",
					sessionId: "session-42",
					onSessionId: sessionChanged,
					historyOpen,
					onHistoryOpenChange: historyChanged,
				}),
			),
		);
	});
}
const dialogs = () => document.querySelectorAll('[data-slot="dialog-content"]');
const pressEscape = () =>
	document.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Escape",
			code: "Escape",
			bubbles: true,
			cancelable: true,
		}),
	);
const history = {
	supported: true,
	sessions: [{ sessionId: "older-session", title: "Older saved session" }],
};
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	chat.state = { permission: null };
	chat.listeners.clear();
	chat.mounts = 0;
	chat.cleanups = 0;
	chat.sessions = [];
	chat.respond.mockReset().mockImplementation(() => publishPermission(null));
	chat.send.mockClear();
	chat.restore.mockClear();
	chat.clear.mockClear();
	chat.rpc.mockReset().mockResolvedValue(history);
	historyChanged.mockClear();
	sessionChanged.mockClear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it("keeps late permission/history overlays out of the hidden library without responding or listing sessions", async () => {
	await render(false);
	const composer = host.querySelector("textarea");
	if (!composer) throw Error("Composer missing");
	composer.value = "Retained unsent draft";
	await act(() => publishPermission(request));
	await render(false, true);
	await act(() => pressEscape());
	expect(dialogs()).toHaveLength(0);
	expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
	expect(chat.respond).not.toHaveBeenCalled();
	expect(historyChanged).not.toHaveBeenCalled();
	expect(chat.rpc).not.toHaveBeenCalled();
	expect(chat.state.permission).toBe(request);
	expect(chat.mounts).toBe(1);
	expect(chat.cleanups).toBe(0);
	await render(true, true);
	expect(dialogs()).toHaveLength(2);
	expect(document.body.textContent).toContain("Pending permission request");
	expect(document.body.textContent).toContain("Older saved session");
	expect(host.querySelector("textarea")).toBe(composer);
	expect(composer.value).toBe("Retained unsent draft");
	await render(false, true);
	expect(dialogs()).toHaveLength(0);
	expect(chat.respond).not.toHaveBeenCalled();
	expect(historyChanged).not.toHaveBeenCalled();
	expect(chat.sessions.every((id) => id === "session-42")).toBe(true);
	expect(sessionChanged).not.toHaveBeenCalled();
});

it("preserves the pending permission, real composer and session across hide/reopen; only visible Escape denies", async () => {
	await render(true);
	const composer = host.querySelector("textarea");
	if (!composer) throw Error("Composer missing");
	composer.value = "Draft survives hide";
	await act(() => publishPermission(request));
	expect(dialogs()).toHaveLength(1);
	await render(false);
	expect(dialogs()).toHaveLength(0);
	expect(chat.state.permission).toBe(request);
	await act(() => pressEscape());
	expect(chat.respond).not.toHaveBeenCalled();
	await render(true);
	expect(dialogs()).toHaveLength(1);
	expect(host.textContent).toContain("Retained session message");
	expect(host.querySelector("textarea")).toBe(composer);
	expect(composer.value).toBe("Draft survives hide");
	expect(chat.mounts).toBe(1);
	expect(chat.cleanups).toBe(0);
	expect(sessionChanged).not.toHaveBeenCalled();
	await act(() => pressEscape());
	expect(chat.respond).toHaveBeenCalledExactlyOnceWith(null);
	expect(chat.state.permission).toBeNull();
	expect(dialogs()).toHaveLength(0);
});

it("drops a late hidden history result without closing stored history state, then reopens and preserves delete confirmation", async () => {
	let finish: (value: AcpListSessionsResult) => void = () => {};
	chat.rpc.mockImplementationOnce(
		() =>
			new Promise<AcpListSessionsResult>((resolve) => {
				finish = resolve;
			}),
	);
	await render(true, true);
	expect(dialogs()).toHaveLength(1);
	expect(chat.rpc).toHaveBeenCalledExactlyOnceWith("agent_list_sessions", {
		agentId: "agent-42",
	});
	await render(false, true);
	await act(async () => {
		finish(history);
	});
	expect(dialogs()).toHaveLength(0);
	expect(historyChanged).not.toHaveBeenCalled();
	await render(true, true);
	expect(document.body.textContent).toContain("Older saved session");
	const remove = document.querySelector<HTMLButtonElement>(
		'button[aria-label="agent.historyDelete"]',
	);
	if (!remove) throw Error("Delete affordance missing");
	await act(() => remove.click());
	expect(remove.getAttribute("aria-expanded")).toBe("true");
	await render(false, true);
	await act(() => pressEscape());
	expect(dialogs()).toHaveLength(0);
	expect(historyChanged).not.toHaveBeenCalled();
	await render(true, true);
	expect(
		document
			.querySelector('button[aria-label="agent.historyDelete"]')
			?.getAttribute("aria-expanded"),
	).toBe("true");
	expect(
		chat.rpc.mock.calls.every(([method]) => method === "agent_list_sessions"),
	).toBe(true);
	expect(chat.respond).not.toHaveBeenCalled();
	expect(chat.restore).not.toHaveBeenCalled();
	expect(chat.clear).not.toHaveBeenCalled();
	await act(() => pressEscape());
	expect(historyChanged).toHaveBeenCalledExactlyOnceWith(false);
	expect(chat.mounts).toBe(1);
	expect(chat.cleanups).toBe(0);
});

it("defaults active to true for existing callers and preserves explicit permission choice", async () => {
	await render(undefined);
	await act(() => publishPermission(request));
	expect(dialogs()).toHaveLength(1);
	const allow = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === "Allow once",
	);
	if (!allow) throw Error("Permission choice missing");
	await act(() => allow.click());
	expect(chat.respond).toHaveBeenCalledExactlyOnceWith("allow-once");
	expect(chat.state.permission).toBeNull();
});
