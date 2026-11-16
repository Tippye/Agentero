/**
 * Whether work that spans many requests may keep running right now.
 *
 * Locking a phone hides the page (iOS also suspends the webview). Requests in
 * flight then fail with a transport error, and no new request can leave the
 * device. Long user-initiated work — bulk PDF translation — waits here instead
 * of reporting work the user did not abandon as failed, and continues by itself
 * once the page is visible and the network is back.
 */

/** Runs covered by a Rust transfer lease may keep requesting while hidden. */
let backgroundContinuations = 0;

/**
 * Allow hidden-page requests until the returned release runs. Only call this
 * after the Host confirmed that a foreground service carries the process; iOS
 * never does, which keeps the pause-on-lock behavior there.
 */
export function holdBackgroundContinuation(): () => void {
	backgroundContinuations += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		backgroundContinuations = Math.max(0, backgroundContinuations - 1);
	};
}

function pageHidden(): boolean {
	return (
		typeof document !== "undefined" && document.visibilityState === "hidden"
	);
}

function offline(): boolean {
	return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** True when a request can be attempted without a lock-screen failure. */
export function appIsAvailable(): boolean {
	if (offline()) return false;
	return !pageHidden() || backgroundContinuations > 0;
}

/**
 * Resolve once the app can issue requests again (visible page, network up).
 * An aborted signal also resolves: the caller owns cancellation and checks the
 * signal itself, so this helper never throws.
 */
export async function waitForAppAvailability(
	signal?: AbortSignal,
): Promise<void> {
	while (!appIsAvailable()) {
		if (signal?.aborted) return;
		await new Promise<void>((resolve) => {
			const wake = () => {
				cleanup();
				resolve();
			};
			const cleanup = () => {
				if (typeof document !== "undefined")
					document.removeEventListener("visibilitychange", wake);
				if (typeof window !== "undefined") {
					window.removeEventListener("online", wake);
					window.removeEventListener("focus", wake);
				}
				signal?.removeEventListener("abort", wake);
			};
			if (typeof document !== "undefined")
				document.addEventListener("visibilitychange", wake);
			if (typeof window !== "undefined") {
				window.addEventListener("online", wake);
				window.addEventListener("focus", wake);
			}
			signal?.addEventListener("abort", wake);
		});
	}
}
