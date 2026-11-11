import { ArrowLeft, LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import agenteroLogo from "@/assets/agentero-logo.svg";
import { useBridgeStatus } from "@/components/mobile/hooks/use-bridge-status";
import { useMobileAgents } from "@/components/mobile/hooks/use-mobile-agents";
import { useMobilePaperSync } from "@/components/mobile/hooks/use-mobile-paper-sync";
import { useMobilePapers } from "@/components/mobile/hooks/use-mobile-papers";
import { useMobileVault } from "@/components/mobile/hooks/use-mobile-vault";
import { usePairOfferLinks } from "@/components/mobile/hooks/use-pair-offer-links";
import { MobileAgentPage } from "@/components/mobile/mobile-agent-page";
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
import { importMobilePdfs } from "@/lib/mobile/import-pdf";
import type { PaperMetadata } from "@/lib/paper/types";

export default function MobileApp() {
	const { t } = useTranslation("mobile");
	const [tab, setTab] = useState<MobileTab>("library");
	const [libraryQuery, setLibraryQuery] = useState("");
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [syncOpen, setSyncOpen] = useState(false);
	const [pairingRequested, setPairingRequested] = useState(false);
	const [pendingOffer, setPendingOffer] = useState<string | null>(null);
	const [selectedPaper, setSelectedPaper] = useState<PaperMetadata | null>(
		null,
	);
	const [readerMode, setReaderMode] = useState<MobileReaderMode>("pdf");
	const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [agentProvider, setAgentProvider] = useState("ds-harness-remote");
	const [remoteSession, setRemoteSession] = useState<SessionRef | null>(null);
	const [notesDirty, setNotesDirty] = useState(false);
	const [importing, setImporting] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const {
		vaultPath,
		loading: vaultLoading,
		retry: retryVault,
	} = useMobileVault();

	const { status, setStatus, pairPending } = useBridgeStatus();
	const paired = status.paired;
	const connected = status.connected;
	const {
		papers,
		loading: papersLoading,
		refresh,
	} = useMobilePapers({ vaultPath });
	const rescanAfterSync = useCallback(() => refresh(true), [refresh]);
	const refreshAfterDownload = useCallback(() => refresh(), [refresh]);
	const paperSync = useMobilePaperSync({
		vaultPath,
		papers,
		active: !syncOpen,
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
		agentVisible: tab === "agent" && agentProvider === "agentero-bridge",
	});

	const acceptPairOffer = useCallback((offerUrl: string) => {
		setAgentProvider("agentero-bridge");
		setPendingOffer(offerUrl);
		setPairingRequested(true);
	}, []);
	usePairOfferLinks(acceptPairOffer);

	useEffect(() => {
		if (paired) return;
		setAgentSessionId(null);
	}, [paired]);

	const closeReader = useCallback(() => {
		if (notesDirty) {
			notifyError(t("reader.unsavedNotes"));
			return;
		}
		setSelectedPaper(null);
		setReaderMode("pdf");
	}, [notesDirty, t]);

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
				setTab("agent");
				return;
			}
			if (dx > 60 && tab === "agent") {
				setTab("library");
			}
		},
	);

	const inReader = tab === "library" && selectedPaper !== null;

	return (
		<div
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
			<aside className="hidden w-20 shrink-0 flex-col items-center border-r bg-muted/25 py-6 md:flex">
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
					onTab={setTab}
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
					showStatus={tab === "agent" && agentProvider === "agentero-bridge"}
					leading={
						inReader ? (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
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
								onChange={setReaderMode}
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
								<div className="relative w-[min(10rem,28vw)]">
									<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
									<Input
										value={libraryQuery}
										onChange={(event) => setLibraryQuery(event.target.value)}
										placeholder={t("library.search")}
										aria-label={t("library.search")}
										className="h-12 w-full pl-8 text-base md:text-sm"
									/>
								</div>
							</div>
						) : (
							<div className="flex min-w-0 items-center gap-2">
								<select
									aria-label={t("remote.provider")}
									className="h-12 max-w-40 rounded-md border bg-background px-2 text-base md:text-sm"
									value={agentProvider}
									onChange={(event) => setAgentProvider(event.target.value)}
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
						)
					}
				/>
				<div className="h-16 shrink-0 md:hidden" aria-hidden="true" />
				<div className="min-h-0 flex-1 overflow-hidden">
					{!vaultPath && tab === "library" ? (
						<div className="grid h-full place-items-center p-6" role="status">
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
					) : null}
					{vaultPath && selectedPaper ? (
						<div
							className={cn("h-full min-h-0", tab !== "library" && "hidden")}
						>
							<EdgeSwipeBack onBack={closeReader}>
								<MobileReaderPage
									key={selectedPaper.path ?? selectedPaper.id}
									paper={selectedPaper}
									vaultPath={vaultPath}
									mode={readerMode}
									active={tab === "library" && !pairingRequested && !syncOpen}
									onNotesDirtyChange={setNotesDirty}
									fetchMissing={paperSync.fetchMissing}
								/>
							</EdgeSwipeBack>
						</div>
					) : vaultPath && tab === "library" ? (
						<MobileLibraryPage
							papers={papers}
							loading={papersLoading}
							selected={selectedPaper}
							onSelect={setSelectedPaper}
							query={libraryQuery}
							syncStates={paperSync.states}
							onPinChange={paperSync.setPinned}
							syncProgress={paperSync.progressText}
						/>
					) : null}
					<div
						className={cn(
							"h-full min-h-0",
							(tab !== "agent" || agentProvider !== "ds-harness-remote") &&
								"hidden",
						)}
					>
						<MobileRemoteAgentPage
							active={
								tab === "agent" &&
								agentProvider === "ds-harness-remote" &&
								!pairingRequested
							}
							selection={remoteSession}
							onSelectionChange={setRemoteSession}
						/>
					</div>
					{connected ? (
						<div
							className={cn(
								"h-full min-h-0",
								(tab !== "agent" || agentProvider !== "agentero-bridge") &&
									"hidden",
							)}
						>
							<MobileAgentPage
								key={selectedAgentId ?? "default"}
								selectedAgentId={selectedAgentId}
								sessionId={agentSessionId}
								onSessionId={setAgentSessionId}
								historyOpen={historyOpen}
								onHistoryOpenChange={setHistoryOpen}
							/>
						</div>
					) : tab === "agent" && agentProvider === "agentero-bridge" ? (
						<div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
							<p className="max-w-sm text-muted-foreground text-sm">
								{t("agent.connectionRequired")}
							</p>
							<Button
								className="min-h-12"
								onClick={() => setPairingRequested(true)}
							>
								{t("connect.title")}
							</Button>
						</div>
					) : null}
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
			<MobileSidebar
				onSync={() => setSyncOpen(true)}
				syncDisabled={!vaultPath}
				navigation={
					<MobileNav
						tab={tab}
						variant="sidebar"
						agentTemplate={selectedAgent?.template}
						onTab={(next) => {
							setTab(next);
							setSidebarOpen(false);
						}}
					/>
				}
				open={sidebarOpen}
				status={status}
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
