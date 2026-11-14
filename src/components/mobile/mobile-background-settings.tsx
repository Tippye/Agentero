import { LoaderCircle, RefreshCw } from "lucide-react";
import {
	type JSX,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PageTitle } from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	type BackgroundState,
	configureMobileBackground,
	getMobileBackgroundState,
	openMobileBackgroundSettings,
	requestMobileBackgroundNotifications,
} from "@/lib/mobile/background";

export function MobileBackgroundSettingsPanel({
	active,
	onStateChange,
}: {
	active: boolean;
	onStateChange?: (state: BackgroundState | null) => void;
}): JSX.Element {
	const { t } = useTranslation("mobile");
	const switchId = useId();
	const [state, setState] = useState<BackgroundState | null>(null);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(false);
	const mounted = useRef(false);
	const opened = useRef(active);
	const epoch = useRef(0);
	const sequence = useRef(0);
	const busyRef = useRef(false);
	const observed = useRef<BackgroundState | null>(null);
	const changed = useRef(onStateChange);
	const translate = useRef(t);
	opened.current = active;
	changed.current = onStateChange;
	translate.current = t;
	const current = useCallback(
		(view: number, request: number) =>
			mounted.current &&
			opened.current &&
			epoch.current === view &&
			sequence.current === request,
		[],
	);
	const publish = useCallback(
		(next: BackgroundState, view: number, request: number) => {
			if (!current(view, request)) return false;
			observed.current = next;
			setState(next);
			changed.current?.(next);
			return true;
		},
		[current],
	);
	const failed = useCallback(
		(error: unknown) =>
			notifyError(translate.current("background.failed"), {
				description: errorText(error),
			}),
		[],
	);
	const refresh = useCallback(async () => {
		if (!mounted.current || !opened.current || busyRef.current) return;
		const view = epoch.current;
		const request = ++sequence.current;
		setLoading(true);
		try {
			publish(await getMobileBackgroundState(), view, request);
		} catch (error) {
			if (current(view, request)) failed(error);
		} finally {
			if (current(view, request)) setLoading(false);
		}
	}, [current, failed, publish]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			++epoch.current;
			++sequence.current;
		};
	}, []);
	useEffect(() => {
		++epoch.current;
		++sequence.current;
		const previous = observed.current;
		observed.current = null;
		setState(null);
		setLoading(false);
		if (!active) {
			// Let the host clear the state it mirrors from this panel.
			if (previous) changed.current?.(null);
			return;
		}
		setBusy(busyRef.current);
		void refresh();
		const onFocus = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			++epoch.current;
			++sequence.current;
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
		};
	}, [active, refresh]);

	async function control(
		action: (accept: (next: BackgroundState) => boolean) => Promise<void>,
	) {
		if (!mounted.current || !opened.current || busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setLoading(false);
		const view = epoch.current;
		const request = ++sequence.current; // Invalidate any older focus/manual read.
		try {
			await action((next) => publish(next, view, request));
		} catch (error) {
			if (current(view, request)) failed(error);
		} finally {
			busyRef.current = false;
			if (mounted.current) setBusy(false);
			// Reactivating while an already-dispatched intent finishes requires a new
			// observation, rather than accepting that closed view's acknowledgement.
			if (mounted.current && opened.current && epoch.current !== view)
				void refresh();
		}
	}
	async function toggle(enabled: boolean) {
		if (
			!observed.current?.persistentConnection ||
			observed.current.enabled === enabled
		)
			return;
		await control(async (accept) => {
			if (!enabled) {
				accept(await configureMobileBackground(false));
				return;
			}
			let next = await getMobileBackgroundState();
			if (!accept(next)) return;
			if (!next.persistentConnection) {
				notifyError(translate.current("background.unavailable"));
				return;
			}
			if (!next.foreground) {
				notifyError(translate.current("background.foregroundRequired"));
				return;
			}
			if (next.notificationPermission === "prompt") {
				if (!accept(await requestMobileBackgroundNotifications())) return;
				next = await getMobileBackgroundState();
				if (!accept(next)) return;
			}
			if (!next.persistentConnection) {
				notifyError(translate.current("background.unavailable"));
				return;
			}
			if (!next.foreground) {
				notifyError(translate.current("background.foregroundRequired"));
				return;
			}
			if (
				next.notificationPermission !== "granted" ||
				!next.notificationsEnabled
			) {
				notifyError(translate.current("background.notificationsRequired"));
				return;
			}
			accept(await configureMobileBackground(true));
		});
	}
	async function settings(target: "battery" | "notifications") {
		if (!observed.current?.persistentConnection) return;
		await control(async (accept) => {
			accept(await openMobileBackgroundSettings(target));
		});
	}
	const running = (active: boolean) =>
		t(active ? "background.running" : "background.notRunning");
	return (
		<div className="space-y-4">
			<PageTitle
				title={t("background.title")}
				actions={
					<Button
						type="button"
						variant="ghost"
						className="min-h-11 min-w-11 touch-manipulation"
						disabled={busy || loading}
						aria-label={t("background.refresh")}
						onClick={() => void refresh()}
					>
						{loading ? (
							<LoaderCircle className="size-4 animate-spin" />
						) : (
							<RefreshCw className="size-4" />
						)}
					</Button>
				}
			/>
			<p className="text-muted-foreground text-sm">
				{t("background.description")}
			</p>
			{!state ? (
				loading ? (
					<p
						role="status"
						className="flex items-center gap-2 text-muted-foreground"
					>
						<LoaderCircle className="size-4 animate-spin" />
						{t("background.loading")}
					</p>
				) : (
					<Button
						type="button"
						variant="outline"
						className="min-h-11 touch-manipulation"
						disabled={busy}
						onClick={() => void refresh()}
					>
						{t("local.retry")}
					</Button>
				)
			) : (
				<div className="space-y-4">
					{state.persistentConnection ? (
						<>
							<div>
								<label
									htmlFor={switchId}
									className="flex min-h-11 cursor-pointer items-center justify-between gap-3"
								>
									<span className="font-medium">{t("background.enable")}</span>
									<Switch
										id={switchId}
										checked={state.enabled}
										disabled={busy || (!state.foreground && !state.enabled)}
										onCheckedChange={(value) => void toggle(value)}
									/>
								</label>
								<p className="text-muted-foreground text-xs">
									{t("background.enableHint")}
								</p>
								{!state.foreground && !state.enabled && (
									<p className="mt-2 text-muted-foreground text-xs">
										{t("background.foregroundRequired")}
									</p>
								)}
							</div>
							<dl className="space-y-3 text-sm" aria-live="polite">
								<ObservedRow
									label={t("background.agent")}
									value={running(state.agentActive)}
								/>
								<ObservedRow
									label={t("background.sync")}
									value={running(state.syncActive)}
								/>
								<ObservedRow
									label={t("background.permission")}
									value={t(
										`background.permissions.${state.notificationPermission}`,
									)}
								/>
								<ObservedRow
									label={t("background.notifications")}
									value={t(
										state.notificationsEnabled
											? "background.allowed"
											: "background.blocked",
									)}
								/>
								<ObservedRow
									label={t("background.battery")}
									value={t(
										state.batteryOptimizationIgnored === null
											? "background.unknown"
											: state.batteryOptimizationIgnored
												? "background.unrestricted"
												: "background.restricted",
									)}
								/>
							</dl>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="outline"
									className="min-h-11 touch-manipulation"
									disabled={busy}
									onClick={() => void settings("notifications")}
								>
									{t("background.notificationSettings")}
								</Button>
								<Button
									type="button"
									variant="outline"
									className="min-h-11 touch-manipulation"
									disabled={busy}
									onClick={() => void settings("battery")}
								>
									{t("background.batterySettings")}
								</Button>
							</div>
						</>
					) : (
						<p className="text-muted-foreground text-sm">
							{t("background.systemManaged")}
						</p>
					)}
					{state.finiteTasks && (
						<dl className="text-sm">
							<ObservedRow
								label={t("background.finiteTask")}
								value={running(state.finiteTaskActive)}
							/>
						</dl>
					)}
					{state.finiteTasks && state.finiteTaskExpired && (
						<p className="text-muted-foreground text-xs">
							{t("background.finiteExpired")}
						</p>
					)}
					{state.backgroundTransfer && (
						<p className="text-muted-foreground text-xs">
							{t("background.transfersAvailable")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
function ObservedRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-right">{value}</dd>
		</div>
	);
}
