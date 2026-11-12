import { ArrowLeft, LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import agenteroLogo from "@/assets/agentero-logo.svg";
import { useBridgeStatus } from "@/components/mobile/hooks/use-bridge-status";
import { useMobileAgents } from "@/components/mobile/hooks/use-mobile-agents";
import { useMobilePaperSync } from "@/components/mobile/hooks/use-mobile-paper-sync";
import { useMobilePapers } from "@/components/mobile/hooks/use-mobile-papers";
import { useMobileRoute } from "@/components/mobile/hooks/use-mobile-route";
import { useMobileVault } from "@/components/mobile/hooks/use-mobile-vault";
import { useMobileWorkspaceWidth } from "@/components/mobile/hooks/use-mobile-workspace-width";
import { usePairOfferLinks } from "@/components/mobile/hooks/use-pair-offer-links";
import { MobileAgentPage } from "@/components/mobile/mobile-agent-page";
import { MobileBackgroundSettings } from "@/components/mobile/mobile-background-settings";
import { MobileBridgeReset } from "@/components/mobile/mobile-bridge-reset";
import {
	EdgeSwipeBack,
	useHorizontalSwipe,
} from "@/components/mobile/mobile-gestures";
import { MobileHeader } from "@/components/mobile/mobile-header";
import {
	MobileAgentToolbar,
	MobileReaderModeToggle,
} from "@/components/mobile/mobile-header-actions";
import { MobileLibraryPage } from "@/components/mobile/mobile-library-page";
import { MobileNav, type MobileTab } from "@/components/mobile/mobile-nav";
import { MobilePairing } from "@/components/mobile/mobile-pairing";
import { MobilePaneGroup } from "@/components/mobile/mobile-pane-group";
import { MobileReaderPage } from "@/components/mobile/mobile-reader-page";
import { MobileSidebar } from "@/components/mobile/mobile-sidebar";
import { MobileSyncPanel } from "@/components/mobile/mobile-sync-panel";
import { MobileRemoteAgentPage } from "@/components/mobile/remote/mobile-remote-agent-page";
import type { MobileReaderMode } from "@/components/mobile/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SessionRef } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	type BackgroundState,
	getMobileBackgroundState,
} from "@/lib/mobile/background";
import { importMobilePdfs } from "@/lib/mobile/import-pdf";
import type { MobilePaperRegionContext } from "@/lib/mobile/paper-context";
import type { MobileWindowRoute } from "@/lib/mobile/route";
import {
	canLeaveMobilePaper,
	type MobileWorkspacePreset,
	mobileWorkspaceLayout,
} from "@/lib/mobile/workspace";
import type { PaperMetadata } from "@/lib/paper/types";
import type { PdfReadingSnapshot } from "@/lib/pdf/reading-position";

export default function MobileApp() {
	const { t } = useTranslation("mobile");
	const [tab, setTab] = useState<MobileTab>("library");
	const [libraryQuery, setLibraryQuery] = useState("");
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [syncOpen, setSyncOpen] = useState(false);
	const [backgroundOpen, setBackgroundOpen] = useState(false);
	const [backgroundState, setBackgroundState] =
		useState<BackgroundState | null>(null);
	const [pairingRequested, setPairingRequested] = useState(false);
	const [pendingOffer, setPendingOffer] = useState<string | null>(null);
	const [selectedPaper, setSelectedPaper] = useState<PaperMetadata | null>(
		null,
	);
	const [readerMode, setReaderMode] = useState<MobileReaderMode>("pdf");
	const [readingSnapshot, setReadingSnapshot] = useState<{
		paperId: string;
		value: PdfReadingSnapshot;
	} | null>(null);
	const [workspacePreset, setWorkspacePreset] =
		useState<MobileWorkspacePreset>("read");
	const [inkDirty, setInkDirty] = useState(false);
	const [inkMode, setInkMode] = useState(false);
	const { ref: workspaceRef, widthClass } =
		useMobileWorkspaceWidth<HTMLDivElement>();
	const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [agentProvider, setAgentProvider] = useState("ds-harness-remote");
	const [remoteSession, setRemoteSession] = useState<SessionRef | null>(null);
	const [regionContext, setRegionContext] =
		useState<MobilePaperRegionContext | null>(null);
	const regionContextRef = useRef<MobilePaperRegionContext | null>(null);
	const [notesDirty, setNotesDirty] = useState(false);
	const [importing, setImporting] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const layout = mobileWorkspaceLayout({
		width: widthClass,
		preset: workspacePreset,
		tab,
		hasPaper: selectedPaper !== null,
	});
	const {
		vaultPath,
		loading: vaultLoading,
		retry: retryVault,
	} = useMobileVault();

	const latestRegionTarget = useRef({
		vaultPath,
		paperId: selectedPaper?.id,
		agentProvider,
		widthClass,
		inkDirty,
		blocked: pairingRequested || syncOpen || backgroundOpen,
	});
	latestRegionTarget.current = {
		vaultPath,
		paperId: selectedPaper?.id,
		agentProvider,
		widthClass,
		inkDirty,
		blocked: pairingRequested || syncOpen || backgroundOpen,
	};

	const { status, setStatus, pairPending, disconnect, resume, resetAvailable } =
		useBridgeStatus(agentProvider === "agentero-bridge" || pairingRequested);
	const paired = status.paired;
	const connected = status.connected;
	const {
		papers,
		loading: papersLoading,
		refresh,
	} = useMobilePapers({ vaultPath });
	const restoreRoute = useCallback(
		(route: MobileWindowRoute) => {
			const paper = papers.find((paper) => paper.id === route.paperId) ?? null;
			setSelectedPaper(paper);
			setReaderMode(route.readerMode);
			setWorkspacePreset(route.preset);
			setTab(route.tab);
			setReadingSnapshot(
				paper && route.pdf && typeof route.pdf.zoom === "number"
					? {
							paperId: paper.id,
							value: { page: route.pdf.page, zoom: route.pdf.zoom },
						}
					: null,
			);
		},
		[papers],
	);
	const { markInteraction } = useMobileRoute({
		vaultPath,
		loading: vaultLoading || papersLoading,
		route: {
			paperId: selectedPaper?.id ?? null,
			tab,
			readerMode,
			preset: workspacePreset,
			pdf:
				selectedPaper && readingSnapshot?.paperId === selectedPaper.id
					? readingSnapshot.value
					: null,
		},
		onRestore: restoreRoute,
	});
	const observeReadingSnapshot = useCallback(
		(paperId: string, value: PdfReadingSnapshot) => {
			if (latestRegionTarget.current.paperId !== paperId) return;
			setReadingSnapshot({ paperId, value });
		},
		[],
	);
	const selectReaderMode = useCallback(
		(mode: MobileReaderMode) => {
			markInteraction();
			setReaderMode(mode);
		},
		[markInteraction],
	);
	const rescanAfterSync = useCallback(() => refresh(true), [refresh]);
	const refreshAfterDownload = useCallback(() => refresh(), [refresh]);
	const paperSync = useMobilePaperSync({
		vaultPath,
		papers,
		active: !syncOpen && !backgroundOpen,
		onChanged: refreshAfterDownload,
	});
	const {
		agents,
		loading: agentsLoading,
		selectedAgent,
		selectedAgentId,
		selectAgent,
	} = useMobileAgents({
		paired,
		connected,
		agentVisible: layout.agent && agentProvider === "agentero-bridge",
	});

	const acceptPairOffer = useCallback((offerUrl: string) => {
		setAgentProvider("agentero-bridge");
		setPendingOffer(offerUrl);
		setPairingRequested(true);
	}, []);
	usePairOfferLinks(acceptPairOffer);

	useEffect(() => {
		if (!sidebarOpen) return;
		let current = true;
		void (async () => {
			try {
				const state = await getMobileBackgroundState();
				if (current) setBackgroundState(state);
			} catch {
				// Optional capability discovery is retried when the menu reopens.
			}
		})();
		return () => {
			current = false;
		};
	}, [sidebarOpen]);

	useEffect(() => {
		if (paired) return;
		setAgentSessionId(null);
	}, [paired]);

	const canLeaveReader = useCallback(() => {
		if (canLeaveMobilePaper(notesDirty, inkDirty)) return true;
		notifyError(t("reader.unsavedChanges"));
		return false;
	}, [notesDirty, inkDirty, t]);
	const closeReader = useCallback(() => {
		if (!canLeaveReader()) return;
		markInteraction();
		setSelectedPaper(null);
		setReadingSnapshot(null);
		setInkMode(false);
		setReaderMode("pdf");
	}, [canLeaveReader, markInteraction]);
	const selectPaper = useCallback(
		(paper: PaperMetadata) => {
			if (selectedPaper?.path === paper.path && selectedPaper?.id === paper.id)
				return;
			if (!canLeaveReader()) return;
			markInteraction();
			setInkMode(false);
			setReadingSnapshot(null);
			setSelectedPaper(paper);
		},
		[selectedPaper, canLeaveReader, markInteraction],
	);
	const selectPreset = useCallback(
		(preset: MobileWorkspacePreset) => {
			if (inkDirty && widthClass === "narrow" && preset !== "read") {
				notifyError(t("reader.unsavedChanges"));
				return;
			}
			markInteraction();
			setWorkspacePreset(preset);
			setReaderMode(preset === "compare" ? "notes" : "pdf");
		},
		[inkDirty, widthClass, t, markInteraction],
	);
	const selectTab = useCallback(
		(next: MobileTab) => {
			if (inkDirty && next !== "library") {
				notifyError(t("reader.unsavedChanges"));
				return;
			}
			markInteraction();
			setTab(next);
		},
		[inkDirty, t, markInteraction],
	);

	const acceptRegionPrompt = useCallback(
		(context: MobilePaperRegionContext) => {
			const current = latestRegionTarget.current;
			if (
				!vaultPath ||
				current.vaultPath !== vaultPath ||
				current.paperId !== context.paperId ||
				current.agentProvider !== "ds-harness-remote" ||
				current.inkDirty ||
				current.blocked
			) {
				notifyError(t("paperContext.staleCapture"));
				return;
			}
			if (regionContextRef.current) {
				notifyError(t("paperContext.pendingAlready"));
				return;
			}
			markInteraction();
			regionContextRef.current = context;
			setRegionContext(context);
			setReaderMode("pdf");
			setWorkspacePreset("discuss");
			setTab(current.widthClass === "narrow" ? "agent" : "library");
		},
		[vaultPath, t, markInteraction],
	);
	const handleRegionContext = useCallback((id: string) => {
		if (regionContextRef.current?.id !== id) return;
		regionContextRef.current = null;
		setRegionContext(null);
	}, []);

	const importFiles = async (files: File[]) => {
		if (!vaultPath || importing || !files.length) return;
		setImporting(true);
		try {
			const result = await importMobilePdfs(vaultPath, files);
			if (result.errors.length) notifyError(result.errors.join("\n"));
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			await refresh();
			setImporting(false);
		}
	};

	const handleSelectAgent = useCallback(
		(agentId: string) => {
			if (agentId === selectedAgentId) return;
			selectAgent(agentId);
			setAgentSessionId(null);
		},
		[selectedAgentId, selectAgent],
	);

	const swipeHandlers = useHorizontalSwipe(
		({ dx, dy, fromEdge, durationMs }) => {
			if (sidebarOpen || selectedPaper) return;
			if (durationMs > 500 || Math.abs(dy) > 60) return;
			const horizontal = Math.abs(dx) > Math.abs(dy) * 1.25;
			if (!horizontal) return;
			if (dx > 60 && fromEdge) {
				setSidebarOpen(true);
				return;
			}
			if (dx < -60 && tab === "library") {
				selectTab("agent");
				return;
			}
			if (dx > 60 && tab === "agent") {
				selectTab("library");
			}
		},
		inkMode || inkDirty || pairingRequested || syncOpen || backgroundOpen,
	);

	const inReader = tab === "library" && selectedPaper !== null;

	return (
		<div
			ref={workspaceRef}
			data-workspace-width={widthClass}
			className="mobile-shell flex h-dvh min-h-0 overflow-hidden bg-background text-foreground"
			{...swipeHandlers}
		>
			<input
				ref={fileInput}
				type="file"
				accept="application/pdf,.pdf"
				multiple
				hidden
				aria-label={t("library.importPdf")}
				onChange={(event) => {
					const files = Array.from(event.target.files ?? []);
					event.target.value = "";
					void importFiles(files);
				}}
			/>
			<aside
				hidden={widthClass !== "wide"}
				style={{ display: widthClass === "wide" ? undefined : "none" }}
				className="flex w-20 shrink-0 flex-col items-center border-r bg-muted/25 py-6"
			>
				<button
					type="button"
					className="grid size-12 place-items-center rounded-lg focus-visible:ring-2 focus-visible:ring-ring"
					aria-label={t("settings.menu")}
					onClick={() => setSidebarOpen(true)}
				>
					<MobileBrand />
				</button>
				<MobileNav
					tab={tab}
					onTab={selectTab}
					agentTemplate={selectedAgent?.template}
				/>
			</aside>
			<main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
				<MobileHeader
					title={inReader ? selectedPaper.title : t(`tabs.${tab}`)}
					status={status}
					statusLabel={
						tab === "library"
							? t("settings.localVault")
							: connected
								? t("settings.connected")
								: t("settings.offline")
					}
					brand={<MobileBrand />}
					brandButtonLabel={t("settings.menu")}
					onBrandClick={() => setSidebarOpen(true)}
					showBrand={!inReader}
					wide={widthClass === "wide"}
					showStatus={layout.agent && agentProvider === "agentero-bridge"}
					leading={
						inReader ? (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="size-11"
								aria-label={t("reader.back")}
								onClick={closeReader}
							>
								<ArrowLeft className="size-4" />
							</Button>
						) : undefined
					}
					trailing={
						inReader ? (
							<MobileReaderModeToggle
								mode={readerMode}
								onChange={selectReaderMode}
								preset={workspacePreset}
								widthClass={widthClass}
								onPresetChange={selectPreset}
							/>
						) : tab === "library" ? (
							<div className="flex shrink-0 items-center gap-1">
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-12"
									disabled={!vaultPath || papersLoading}
									aria-label={t("library.refresh")}
									onClick={() => void refresh(true)}
								>
									<RefreshCw
										className={cn("size-4", papersLoading && "animate-spin")}
									/>
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-12"
									disabled={!vaultPath || importing}
									aria-label={t("library.importPdf")}
									onClick={() => fileInput.current?.click()}
								>
									{importing ? (
										<LoaderCircle className="size-4 animate-spin" />
									) : (
										<Plus className="size-5" />
									)}
								</Button>
								<div
									className={cn(
										"relative min-w-0",
										widthClass === "narrow" ? "w-24" : "w-40",
									)}
								>
									<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
									<Input
										value={libraryQuery}
										onChange={(event) => setLibraryQuery(event.target.value)}
										placeholder={t("library.search")}
										aria-label={t("library.search")}
										className={cn(
											"h-12 w-full pl-8",
											widthClass === "narrow" ? "text-base" : "text-sm",
										)}
									/>
								</div>
							</div>
						) : undefined
					}
				/>
				<div className="min-h-0 flex-1 overflow-hidden">
					<MobilePaneGroup
						id="mobile-workspace"
						layoutKey={`${widthClass}:${workspacePreset}:${tab}:${Boolean(selectedPaper)}`}
						panes={[
							{
								id: "library",
								visible: layout.library,
								weight: 1.3,
								separatorLabel: t("workspace.resizeLibrary"),
								content: vaultPath ? (
									<div className="flex h-full min-h-0 flex-col">
										<div
											hidden={!selectedPaper || widthClass !== "wide"}
											className="shrink-0 border-b p-3"
										>
											<Input
												value={libraryQuery}
												onChange={(event) =>
													setLibraryQuery(event.target.value)
												}
												aria-label={t("library.search")}
												placeholder={t("library.search")}
												className="h-11"
											/>
										</div>
										<div className="min-h-0 flex-1">
											<MobileLibraryPage
												papers={papers}
												loading={papersLoading}
												selected={selectedPaper}
												onSelect={selectPaper}
												query={libraryQuery}
												syncStates={paperSync.states}
												onPinChange={paperSync.setPinned}
												syncProgress={paperSync.progressText}
											/>
										</div>
									</div>
								) : (
									<div
										className="grid h-full place-items-center p-6"
										role="status"
									>
										{vaultLoading ? (
											<div className="flex items-center gap-2 text-muted-foreground">
												<LoaderCircle className="size-5 animate-spin" />
												{t("local.opening")}
											</div>
										) : (
											<Button
												variant="outline"
												className="min-h-12"
												onClick={retryVault}
											>
												{t("local.retry")}
											</Button>
										)}
									</div>
								),
							},
							{
								id: "reader",
								visible: layout.reader,
								weight: workspacePreset === "discuss" ? 2 : 3.7,
								separatorLabel: t("workspace.resizeDiscussion"),
								content: (
									<EdgeSwipeBack
										onBack={closeReader}
										disabled={
											widthClass === "wide" ||
											notesDirty ||
											inkDirty ||
											inkMode ||
											pairingRequested ||
											syncOpen ||
											backgroundOpen
										}
									>
										{vaultPath && selectedPaper ? (
											<MobileReaderPage
												key={selectedPaper.path ?? selectedPaper.id}
												paper={selectedPaper}
												vaultPath={vaultPath}
												mode={readerMode}
												preset={workspacePreset}
												widthClass={widthClass}
												active={
													layout.reader &&
													!pairingRequested &&
													!syncOpen &&
													!backgroundOpen
												}
												initialReadingSnapshot={
													readingSnapshot?.paperId === selectedPaper.id
														? readingSnapshot.value
														: null
												}
												onReadingSnapshotChange={observeReadingSnapshot}
												onNotesDirtyChange={setNotesDirty}
												onInkDirtyChange={setInkDirty}
												onInkModeChange={setInkMode}
												fetchMissing={paperSync.fetchMissing}
												onRegionPrompt={
													agentProvider === "ds-harness-remote"
														? acceptRegionPrompt
														: undefined
												}
											/>
										) : null}
									</EdgeSwipeBack>
								),
							},
							{
								id: "agent",
								visible: layout.agent,
								weight: 1.7,
								content: (
									<div className="flex h-full min-h-0 flex-col">
										<div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
											<select
												aria-label={t("remote.provider")}
												className="h-11 min-w-0 max-w-full rounded-md border bg-background px-2 text-base"
												value={agentProvider}
												onChange={(event) =>
													setAgentProvider(event.target.value)
												}
											>
												<option value="ds-harness-remote">
													{t("remote.dshProvider")}
												</option>
												<option value="agentero-bridge">
													{t("remote.bridgeProvider")}
												</option>
											</select>
											{agentProvider === "agentero-bridge" ? (
												<MobileAgentToolbar
													agents={agents}
													loading={agentsLoading}
													selectedAgentId={selectedAgentId}
													onSelectAgent={handleSelectAgent}
													onOpenHistory={() => setHistoryOpen(true)}
												/>
											) : null}
										</div>
										<div
											hidden={agentProvider !== "ds-harness-remote"}
											style={{
												display:
													agentProvider !== "ds-harness-remote"
														? "none"
														: undefined,
											}}
											className="min-h-0 flex-1"
										>
											<MobileRemoteAgentPage
												active={
													layout.agent &&
													agentProvider === "ds-harness-remote" &&
													!pairingRequested &&
													!syncOpen &&
													!backgroundOpen
												}
												selection={remoteSession}
												onSelectionChange={setRemoteSession}
												regionContext={regionContext}
												onRegionContextHandled={handleRegionContext}
											/>
										</div>
										<div
											hidden={agentProvider !== "agentero-bridge"}
											style={{
												display:
													agentProvider !== "agentero-bridge"
														? "none"
														: undefined,
											}}
											className="min-h-0 flex-1"
										>
											{connected ? (
												<MobileAgentPage
													key={selectedAgentId ?? "default"}
													selectedAgentId={selectedAgentId}
													sessionId={agentSessionId}
													onSessionId={setAgentSessionId}
													historyOpen={historyOpen}
													onHistoryOpenChange={setHistoryOpen}
												/>
											) : (
												<div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
													<p className="max-w-sm text-muted-foreground text-sm">
														{t("agent.connectionRequired")}
													</p>
													{paired ? (
														<Button
															variant="outline"
															className="min-h-12"
															onClick={() => void resume()}
														>
															{t("local.retry")}
														</Button>
													) : null}
													{resetAvailable ? (
														<MobileBridgeReset onStatus={setStatus} />
													) : null}
													<Button
														className="min-h-12"
														onClick={() => setPairingRequested(true)}
													>
														{t("connect.title")}
													</Button>
												</div>
											)}
										</div>
									</div>
								),
							},
						]}
					/>
				</div>
			</main>
			<Dialog open={pairingRequested} onOpenChange={setPairingRequested}>
				<DialogContent
					showCloseButton={false}
					aria-describedby={undefined}
					className="h-dvh w-screen max-w-none rounded-none bg-background p-0 sm:max-w-none"
				>
					<DialogTitle className="sr-only">{t("connect.title")}</DialogTitle>
					<MobilePairing
						status={status}
						pending={pairPending}
						initialOffer={pendingOffer}
						onStatus={setStatus}
						onDone={() => {
							setPendingOffer(null);
							setPairingRequested(false);
						}}
					/>
				</DialogContent>
			</Dialog>
			<MobileSyncPanel
				open={syncOpen}
				vaultPath={vaultPath}
				onOpenChange={setSyncOpen}
				onSynced={rescanAfterSync}
			/>
			<MobileBackgroundSettings
				open={backgroundOpen}
				onOpenChange={setBackgroundOpen}
				onStateChange={setBackgroundState}
			/>
			<MobileSidebar
				onBackground={
					backgroundState?.persistentConnection
						? () => setBackgroundOpen(true)
						: undefined
				}
				onSync={() => setSyncOpen(true)}
				syncDisabled={!vaultPath}
				navigation={
					<MobileNav
						tab={tab}
						variant="sidebar"
						agentTemplate={selectedAgent?.template}
						onTab={(next) => {
							selectTab(next);
							setSidebarOpen(false);
						}}
					/>
				}
				open={sidebarOpen}
				status={status}
				onDisconnect={disconnect}
				onClose={() => setSidebarOpen(false)}
				onStatus={setStatus}
				onPairAnother={() => {
					setAgentProvider("agentero-bridge");
					setPendingOffer(null);
					setPairingRequested(true);
				}}
			/>
		</div>
	);
}

function MobileBrand() {
	return <img src={agenteroLogo} alt="Agentero" className="size-8" />;
}
