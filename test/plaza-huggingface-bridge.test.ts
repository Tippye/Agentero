import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const rust = readFileSync(
	new URL(
		"../src-tauri/src/features/paper/discovery/proxy/huggingface.rs",
		import.meta.url,
	),
	"utf8",
);
const script = rust.match(/r##"<script>([\s\S]*?)<\/script>"##/)?.[1];
if (!script) throw new Error("Missing Hugging Face navigation bridge");

function frame(origin: string) {
	const url = new URL(`${origin}/papers`);
	const assign = vi.fn();
	const postMessage = vi.fn();
	const listeners: Record<string, (event: unknown) => void> = {};
	const history = { pushState: vi.fn(), replaceState: vi.fn() };
	const window = { addEventListener: vi.fn(), open: vi.fn() };
	runInNewContext(script as string, {
		URL,
		location: {
			href: url.href,
			pathname: url.pathname,
			search: url.search,
			host: url.host,
			protocol: url.protocol,
			assign,
		},
		parent: { postMessage },
		document: {
			addEventListener: (name: string, listener: (event: unknown) => void) => {
				listeners[name] = listener;
			},
		},
		window,
		history,
	});
	const click = (href: string) => {
		listeners.click({
			button: 0,
			target: { closest: () => ({ getAttribute: () => href }) },
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		});
	};
	return { click, assign, postMessage, history, window };
}

describe.each([
	"agentero-huggingface://localhost",
	"http://agentero-huggingface.localhost",
])("Hugging Face navigation at %s", (origin) => {
	it("keeps relative and absolute paper links inside the proxy", () => {
		const bridge = frame(origin);
		bridge.click("/papers?date=2026-11-13");
		expect(bridge.assign).toHaveBeenLastCalledWith(
			`${origin}/papers?date=2026-11-13`,
		);
		bridge.click("https://huggingface.co/papers/2611.00001");
		expect(bridge.assign).toHaveBeenLastCalledWith(
			`${origin}/papers/2611.00001`,
		);
	});

	it("sends external links to the host and ignores script URLs", () => {
		const bridge = frame(origin);
		bridge.click("https://arxiv.org/abs/2611.00001");
		expect(bridge.postMessage).toHaveBeenLastCalledWith(
			{
				source: "agentero-plaza",
				external: "https://arxiv.org/abs/2611.00001",
			},
			"*",
		);
		bridge.click("//arxiv.org/abs/2611.00002");
		expect(bridge.postMessage).toHaveBeenLastCalledWith(
			{
				source: "agentero-plaza",
				external: "https://arxiv.org/abs/2611.00002",
			},
			"*",
		);
		bridge.click("javascript:alert(1)");
		expect(bridge.assign).not.toHaveBeenCalled();
		expect(bridge.postMessage).toHaveBeenCalledTimes(3);
	});

	it("reports the initial route and client-side navigation", () => {
		const bridge = frame(origin);
		bridge.history.pushState();
		expect(bridge.postMessage).toHaveBeenCalledTimes(2);
		expect(bridge.postMessage).toHaveBeenLastCalledWith(
			{ source: "agentero-plaza", path: "/papers" },
			"*",
		);
	});
});
