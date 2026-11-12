import type {
	Capabilities,
	OperationOutcome,
	OperationRequest,
	RemoteAttachment,
	SessionRef,
} from "@/lib/core/bindings";
import type {
	MobilePaperRegionContext,
	MobilePaperRegionSource,
} from "@/lib/mobile/paper-context";
import {
	canUpload,
	type OperationJournal,
	sessionKey,
	supports,
} from "@/lib/remote-agent/model";

export function supportsRegionImage(
	capabilities: Capabilities | undefined,
): boolean {
	const limits = capabilities?.attachments;
	return (
		canUpload(capabilities) &&
		Boolean(
			limits &&
				Number.isFinite(limits.maxBytes) &&
				limits.maxBytes >= 33 &&
				(limits.mimeTypes.length === 0 ||
					limits.mimeTypes.includes("application/octet-stream")),
		)
	);
}
export function regionSource(
	context: MobilePaperRegionSource,
): MobilePaperRegionSource {
	return {
		id: context.id,
		paperId: context.paperId,
		title: context.title,
		page: context.page,
		region: {
			x: context.region.x,
			y: context.region.y,
			w: context.region.w,
			h: context.region.h,
		},
	};
}
export function regionPromptValues(source: MobilePaperRegionSource) {
	return {
		sourceId: JSON.stringify(source.id),
		title: JSON.stringify(source.title),
		page: source.page,
		region: JSON.stringify(regionSource(source).region),
	};
}
function captureSession(session: SessionRef): SessionRef {
	const workspace = session.workspace;
	return {
		sessionId: session.sessionId,
		workspace: {
			workspaceId: workspace.workspaceId,
			backendId: workspace.backendId,
			host: {
				hostId: workspace.host.hostId,
				connection: {
					providerId: workspace.host.connection.providerId,
					connectionId: workspace.host.connection.connectionId,
				},
			},
		},
	};
}
function attachmentFor(attachment: RemoteAttachment, target: string): boolean {
	return sessionKey(attachment.session) === target;
}
function sendConfirmed(outcome: OperationOutcome | undefined): boolean {
	return outcome?.status === "accepted" || outcome?.status === "succeeded";
}

type StageImage = (
	context: MobilePaperRegionContext,
	maxBytes: number,
) => Promise<{ path: string; remove: () => Promise<void> }>;
export type RegionWorkflowDependencies = {
	stage: StageImage;
	upload: (
		session: SessionRef,
		path: string,
		operationId: string,
	) => Promise<OperationOutcome>;
	send: (request: OperationRequest) => Promise<OperationOutcome>;
	operationId?: () => string;
};
type Operation = { id: string; outcome?: OperationOutcome };
type Attempt = {
	source: MobilePaperRegionSource;
	session: SessionRef;
	target: string;
	upload?: Operation;
	send?: Operation;
	attachment?: RemoteAttachment;
	mismatch: boolean;
	remembered: boolean;
};
export type RegionOperationReference = { id: string; session: SessionRef };
export type RegionWorkflowResult = {
	kind:
		| "sent"
		| "alreadySent"
		| "uncertain"
		| "rejected"
		| "stale"
		| "busy"
		| "blocked"
		| "unsupportedImage"
		| "invalidImage"
		| "attachmentMismatch";
	contextId: string;
	target: string;
	current: boolean;
	operationId?: string;
	outcome?: OperationOutcome;
};
export type RegionSendInput = {
	context: MobilePaperRegionContext;
	includeImage: boolean;
	session: SessionRef;
	capabilities: Capabilities | undefined;
	text: string;
	attachments: RemoteAttachment[];
	journal: OperationJournal;
	isCurrent: () => boolean;
	formatReference: (
		source: MobilePaperRegionSource,
		imageAttached: boolean,
	) => string;
	onCleanupFailure?: () => void;
};

/** In-memory workflow state contains source metadata and remote acknowledgements only.
 * Creating it, reading a preview or receiving a context never stages or dispatches anything. */
export class RegionContextWorkflow {
	private attempts = new Map<string, Attempt>();
	private sources = new Map<string, Map<string, MobilePaperRegionSource>>();
	private busy = false;
	constructor(private dependencies: RegionWorkflowDependencies) {}
	private key(contextId: string, target: string) {
		return JSON.stringify([contextId, target]);
	}
	private remember(attempt: Attempt) {
		if (attempt.remembered) return;
		attempt.remembered = true;
		let sources = this.sources.get(attempt.target);
		if (!sources) {
			sources = new Map();
			this.sources.set(attempt.target, sources);
		}
		sources.set(attempt.source.id, regionSource(attempt.source));
		while (sources.size > 64) {
			const oldest = sources.keys().next().value;
			if (oldest === undefined) break;
			sources.delete(oldest);
		}
		while (this.sources.size > 8) {
			const oldest = this.sources.keys().next().value;
			if (oldest === undefined) break;
			this.sources.delete(oldest);
		}
	}
	references(target: string): MobilePaperRegionSource[] {
		return [...(this.sources.get(target)?.values() ?? [])].map(regionSource);
	}
	discard(contextId: string): void {
		for (const [key, attempt] of this.attempts)
			if (attempt.source.id === contextId) this.attempts.delete(key);
	}
	ownsOperation(id: string): boolean {
		return [...this.attempts.values()].some(
			(attempt) => attempt.upload?.id === id || attempt.send?.id === id,
		);
	}
	private applyUpload(attempt: Attempt, outcome: OperationOutcome) {
		if (!attempt.upload) return;
		attempt.upload.outcome = outcome;
		attempt.mismatch = false;
		if (
			outcome.status === "succeeded" &&
			outcome.result.type === "attachmentUploaded"
		) {
			if (!attachmentFor(outcome.result.attachment, attempt.target)) {
				attempt.mismatch = true;
				attempt.attachment = undefined;
			} else
				attempt.attachment = {
					...outcome.result.attachment,
					session: captureSession(outcome.result.attachment.session),
				};
		} else attempt.attachment = undefined;
	}
	private reconcile(journal: OperationJournal) {
		const outcomes = new Map(
			journal.all().map((entry) => [entry.id, entry.outcome]),
		);
		for (const attempt of this.attempts.values()) {
			const upload = attempt.upload && outcomes.get(attempt.upload.id);
			if (upload) this.applyUpload(attempt, upload);
			const send = attempt.send && outcomes.get(attempt.send.id);
			if (send && attempt.send) attempt.send.outcome = send;
			if (sendConfirmed(attempt.send?.outcome)) this.remember(attempt);
		}
	}
	private uncertain(attempt: Attempt): boolean {
		return Boolean(
			attempt.mismatch ||
				(attempt.upload &&
					attempt.upload.outcome?.status !== "rejected" &&
					!attempt.attachment) ||
				attempt.send?.outcome?.status === "unknown",
		);
	}
	state(contextId: string, target: string | null, journal: OperationJournal) {
		this.reconcile(journal);
		const attempts = [...this.attempts.values()].filter(
			(attempt) => attempt.source.id === contextId,
		);
		const current = target
			? this.attempts.get(this.key(contextId, target))
			: undefined;
		return {
			uncertain: attempts.some((attempt) => this.uncertain(attempt)),
			uploaded: Boolean(current?.attachment),
			sent: sendConfirmed(current?.send?.outcome),
		};
	}
	pendingOperations(
		contextId: string,
		journal: OperationJournal,
	): RegionOperationReference[] {
		this.reconcile(journal);
		const pending: RegionOperationReference[] = [];
		for (const attempt of this.attempts.values()) {
			if (attempt.source.id !== contextId) continue;
			if (
				attempt.upload &&
				!attempt.attachment &&
				attempt.upload.outcome?.status !== "rejected"
			)
				pending.push({
					id: attempt.upload.id,
					session: captureSession(attempt.session),
				});
			if (attempt.send?.outcome?.status === "unknown")
				pending.push({
					id: attempt.send.id,
					session: captureSession(attempt.session),
				});
		}
		return pending;
	}
	observedSend(
		id: string,
		journal: OperationJournal,
	): { contextId: string; target: string } | null {
		this.reconcile(journal);
		const attempt = [...this.attempts.values()].find(
			(attempt) => attempt.send?.id === id,
		);
		return attempt && sendConfirmed(attempt.send?.outcome)
			? { contextId: attempt.source.id, target: attempt.target }
			: null;
	}
	async submit(input: RegionSendInput): Promise<RegionWorkflowResult> {
		const session = captureSession(input.session);
		const target = sessionKey(session);
		const result = (
			kind: RegionWorkflowResult["kind"],
			extra: Partial<RegionWorkflowResult> = {},
		): RegionWorkflowResult => ({
			kind,
			contextId: input.context.id,
			target,
			current: input.isCurrent(),
			...extra,
		});
		if (this.busy) return result("busy");
		this.reconcile(input.journal);
		const previous = this.attempts.get(this.key(input.context.id, target));
		if (sendConfirmed(previous?.send?.outcome)) return result("alreadySent");
		if (this.state(input.context.id, target, input.journal).uncertain)
			return result("uncertain");
		if (
			input.journal.blocked(target) ||
			!supports(input.capabilities, "sendMessage")
		)
			return result("blocked");
		if (!input.isCurrent()) return result("stale");
		if (
			input.attachments.some((attachment) => !attachmentFor(attachment, target))
		)
			return result("attachmentMismatch");
		if (
			input.includeImage &&
			!previous?.attachment &&
			!supportsRegionImage(input.capabilities)
		)
			return result("unsupportedImage");
		this.busy = true;
		const attempt: Attempt = previous ?? {
			source: regionSource(input.context),
			session,
			target,
			mismatch: false,
			remembered: false,
		};
		this.attempts.set(this.key(input.context.id, target), attempt);
		// Snapshot the caller's unrelated attachments before any staging/upload await.
		const attachments = input.attachments.map((attachment) => ({
			...attachment,
			session: captureSession(attachment.session),
		}));
		const operationId =
			this.dependencies.operationId ?? (() => crypto.randomUUID());
		try {
			if (input.includeImage && !attempt.attachment) {
				let staged: Awaited<ReturnType<StageImage>>;
				try {
					staged = await this.dependencies.stage(
						input.context,
						input.capabilities?.attachments?.maxBytes ?? 0,
					);
				} catch {
					return result("invalidImage");
				}
				try {
					if (!input.isCurrent()) return result("stale");
					const id = operationId();
					attempt.upload = { id };
					const outcome = await input.journal.dispatch(id, target, () =>
						this.dependencies.upload(session, staged.path, id),
					);
					this.applyUpload(attempt, outcome);
					if (attempt.mismatch)
						return result("attachmentMismatch", { operationId: id, outcome });
					if (outcome.status === "rejected")
						return result("rejected", { operationId: id, outcome });
					if (!attempt.attachment)
						return result("uncertain", { operationId: id, outcome });
				} finally {
					try {
						await staged.remove();
					} catch {
						input.onCleanupFailure?.();
					}
				}
			}
			if (!input.isCurrent()) return result("stale");
			if (input.journal.blocked(target)) return result("blocked");
			if (input.includeImage && attempt.attachment)
				attachments.push(attempt.attachment);
			const evidence = input.formatReference(
				attempt.source,
				input.includeImage && Boolean(attempt.attachment),
			);
			const text = input.text.trim()
				? `${input.text}\n\n${evidence}`
				: evidence;
			const id = operationId();
			attempt.send = { id };
			const outcome = await input.journal.dispatch(id, target, () =>
				this.dependencies.send({
					operationId: id,
					mutation: { type: "sendMessage", session, text, attachments },
				}),
			);
			attempt.send.outcome = outcome;
			if (sendConfirmed(outcome)) {
				this.remember(attempt);
				return result("sent", { operationId: id, outcome });
			}
			return result(outcome.status === "rejected" ? "rejected" : "uncertain", {
				operationId: id,
				outcome,
			});
		} finally {
			this.busy = false;
		}
	}
}
