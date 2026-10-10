import type { ProgressEvent } from "@pairmesh/protocol";
import type { ControlActionInboxView } from "../control/action-inbox.js";
import type { InspectionSafeView } from "../session/receiver-inspections.js";
import { buildActivityDisplayItems } from "../progress/activity-display.js";
import { prepareOwnerActivityTimeline } from "./owner-activity-summary.js";
import { formatCodingAgentProviderDisplayName } from "../control/action-inbox.js";

export const WATCH_POLL_MS = 1000;
export const WATCH_IDLE_POLL_MS = 3000;

export type WatchActionCandidate = ControlActionInboxView & {
  kind?: "action";
  /** Local owner service label (Kelvin's workspace), never an absolute path. */
  localService?: string;
};

export type WatchInspectionCandidate = InspectionSafeView & {
  kind: "inspection";
  localService?: string;
  requestSummary?: string;
  actionLabel?: string;
};

export type WatchCandidate = WatchActionCandidate | WatchInspectionCandidate;

export function isWatchInspectionCandidate(
  candidate: WatchCandidate
): candidate is WatchInspectionCandidate {
  return (candidate as WatchInspectionCandidate).kind === "inspection";
}

export function isWatchableActiveAction(action: { status?: string; terminal?: boolean }): boolean {
  if (!action || action.terminal === true) {
    return false;
  }
  return (
    action.status === "requested" ||
    action.status === "authenticating" ||
    action.status === "authorizing" ||
    action.status === "approved" ||
    action.status === "executing"
  );
}

export function isWatchableActiveInspection(inspection: {
  status?: string;
  terminal?: boolean;
}): boolean {
  if (!inspection || inspection.terminal === true) {
    return false;
  }
  return inspection.status === "pending" || inspection.status === "running";
}

export function isWatchableActiveWork(candidate: WatchCandidate): boolean {
  if (isWatchInspectionCandidate(candidate)) {
    return isWatchableActiveInspection(candidate);
  }
  return isWatchableActiveAction(candidate);
}

export function isWatchActionLive(action: { status?: string }): boolean {
  return action.status === "executing" || action.status === "approved";
}

export function isWatchInspectionLive(inspection: { status?: string }): boolean {
  return inspection.status === "running";
}

export function isWatchWorkLive(candidate: WatchCandidate): boolean {
  if (isWatchInspectionCandidate(candidate)) {
    return isWatchInspectionLive(candidate);
  }
  return isWatchActionLive(candidate);
}

export function isWatchProposalReviewable(action: {
  status?: string;
  needsApproval?: boolean;
  progress?: readonly ProgressEvent[];
}): boolean {
  if (action.status === "approval_required" && action.needsApproval) {
    return true;
  }
  const progress = Array.isArray(action.progress) ? action.progress : [];
  return progress.some(
    (event) => event.activityKind === "proposal.ready" || event.phase === "proposal_ready"
  );
}

export function progressEventWatchKey(event: ProgressEvent): string {
  if (event.providerEventId) {
    return `id:${event.providerEventId}`;
  }
  if (typeof event.sequence === "number") {
    return `seq:${event.operationId}:${event.sequence}`;
  }
  return `fallback:${event.timestamp}:${event.phase}:${event.activityKind ?? ""}:${event.message ?? ""}`;
}

export function prepareWatchTimeline(
  events: readonly ProgressEvent[] | undefined
): ProgressEvent[] {
  return prepareOwnerActivityTimeline(events);
}

export function watchCandidateUpdatedAt(candidate: WatchCandidate): number {
  return Date.parse(candidate.updatedAt);
}

/** Merge active actions + inspections for watch discovery (newest first). */
export function mergeWatchCandidates(input: {
  actions: readonly WatchActionCandidate[];
  inspections: readonly WatchInspectionCandidate[];
}): WatchCandidate[] {
  const actions: WatchCandidate[] = input.actions.map((action) => ({
    ...action,
    kind: "action" as const
  }));
  const inspections: WatchCandidate[] = [...input.inspections];
  return [...actions, ...inspections].sort(
    (a, b) => watchCandidateUpdatedAt(b) - watchCandidateUpdatedAt(a)
  );
}

export function enrichInspectionForWatch(
  view: InspectionSafeView,
  options?: { codingAgentProviderId?: string; localService?: string }
): WatchInspectionCandidate {
  const question = view.question.trim();
  const requestSummary = question.length > 240 ? `${question.slice(0, 237)}…` : question;
  const providerDisplayName =
    view.providerDisplayName ??
    (options?.codingAgentProviderId
      ? formatCodingAgentProviderDisplayName(options.codingAgentProviderId)
      : undefined);
  return {
    ...view,
    kind: "inspection",
    actionLabel: "Inspection",
    requestSummary,
    ...(providerDisplayName ? { providerDisplayName } : {}),
    ...(options?.localService ? { localService: options.localService } : {})
  };
}

export function formatWatchSelectionLine(
  candidate: WatchCandidate,
  options?: { selected?: boolean }
): string {
  const peer = candidate.peer?.displayName?.trim() || "Peer";
  const service = candidate.localService?.trim() || candidate.peer?.service?.trim() || undefined;
  const left = service ? `${peer} · ${service}` : peer;
  const summary = isWatchInspectionCandidate(candidate)
    ? candidate.requestSummary?.trim() ||
      candidate.summary?.trim() ||
      candidate.question.trim() ||
      "Inspection"
    : candidate.requestSummary?.trim() ||
      candidate.summary?.trim() ||
      candidate.actionLabel?.trim() ||
      "Remote work";
  const marker = options?.selected ? "›" : " ";
  return `${marker} ${left} — ${summary}`;
}

export function formatWatchHeader(candidate: WatchCandidate): string[] {
  const requester = candidate.peer?.displayName?.trim() || "Peer";
  const localService = candidate.localService?.trim();
  const peerService = candidate.peer?.service?.trim();
  const titleRight = localService || peerService;
  const live = isWatchWorkLive(candidate);
  const statusMark = live ? "● LIVE" : candidate.terminal ? "○ DONE" : "○";
  const provider = candidate.providerDisplayName?.trim();

  if (isWatchInspectionCandidate(candidate)) {
    const who =
      provider && titleRight
        ? `${requester} → ${provider}`
        : provider
          ? `${requester} → ${provider}`
          : titleRight
            ? `Incoming from ${requester} · ${titleRight}`
            : `Incoming from ${requester}`;
    const lines: string[] = [who];
    const question = candidate.requestSummary?.trim() || candidate.question?.trim();
    if (question) {
      lines.push(`"${question.length > 200 ? `${question.slice(0, 197)}…` : question}"`);
    }
    const pad = Math.max(1, 56 - who.length);
    lines[0] = `${who}${" ".repeat(pad)}${statusMark}`;
    return lines;
  }

  const title = titleRight ? `${requester} → ${titleRight}` : requester;
  const pad = Math.max(1, 56 - title.length);
  const lines = [`${title}${" ".repeat(pad)}${statusMark}`];
  if (provider) {
    lines.push(provider);
  }
  const summary =
    candidate.requestSummary?.trim() || candidate.summary?.trim() || candidate.actionLabel?.trim();
  if (summary) {
    lines.push(summary.startsWith('"') ? summary : `"${summary}"`);
  }
  return lines;
}

export type WatchTimelineLine = {
  key: string;
  marker: "✓" | "◐" | "●" | "✗" | "○";
  label: string;
  event: ProgressEvent;
};

export function formatWatchTimelineLines(
  events: readonly ProgressEvent[] | undefined,
  options?: { live?: boolean }
): WatchTimelineLine[] {
  const live = options?.live === true;
  const items = buildActivityDisplayItems(events, "owner");
  return items.map((item, index) => {
    const isLast = index === items.length - 1;
    let marker: WatchTimelineLine["marker"];
    if (item.emphasis === "terminal") {
      marker = /failed/i.test(item.label) ? "✗" : /cancelled/i.test(item.label) ? "○" : "✓";
    } else if (item.emphasis === "waiting") {
      marker = "○";
    } else if (live && isLast) {
      marker = "◐";
    } else if (live) {
      marker = "●";
    } else {
      // Finished replay — checkmarks read cleaner than bullets.
      marker = "✓";
    }
    return {
      key: item.key,
      marker,
      label: item.narration && !item.label.includes('"') ? `"${item.label}"` : item.label,
      event: item.event
    };
  });
}

export function formatWatchReviewHandoff(options?: { includeReadyLine?: boolean }): string[] {
  const lines: string[] = [];
  if (options?.includeReadyLine !== false) {
    lines.push("✓ Proposal ready", "");
  }
  lines.push("Waiting for your review.", "Press R to open Review.");
  return lines;
}

export function formatWatchEmptyState(): string {
  return "No active PairMesh work right now.";
}

/** Shown once when watch enters idle wait (does not exit). */
export function formatWatchWaitingState(): string {
  return "Waiting for next PairMesh work…";
}

export function formatWatchSelectionPrompt(): string {
  return "What do you want to watch?";
}

/**
 * Idle watch stays open until Ctrl+C / q, or `--once` with nothing to watch.
 * When active work appears, watch begins automatically (or after selection).
 */
export function shouldKeepWaitingForActiveWork(input: {
  stopRequested?: boolean;
  once?: boolean;
  activeCount: number;
}): boolean {
  if (input.stopRequested) {
    return false;
  }
  if (input.activeCount > 0) {
    return false;
  }
  if (input.once) {
    return false;
  }
  return true;
}

/**
 * After watched work finishes, return to idle wait unless once/stop.
 */
export function shouldResumeIdleWaitAfterWatch(input: {
  stopRequested?: boolean;
  once?: boolean;
}): boolean {
  if (input.stopRequested || input.once) {
    return false;
  }
  return true;
}

/**
 * Keep the live watch loop (and R key) alive after a terminal proposal-ready action
 * until the owner opens Review or quits. Without this, propose completes → idle wait
 * and "Press R" is printed with no handler bound.
 * Inspections never hold for R (no approval in watch).
 *
 * Callers must also poll for other active work and release via
 * `shouldReleaseWatchReviewHoldForOtherWork` — otherwise a later ask stays invisible.
 */
export function shouldHoldWatchForReviewKeypress(input: {
  terminal?: boolean;
  once?: boolean;
  stopRequested?: boolean;
  reviewHandoffPrinted?: boolean;
  reviewable?: boolean;
  reviewOpened?: boolean;
}): boolean {
  if (input.stopRequested || input.once || input.reviewOpened) {
    return false;
  }
  if (!input.terminal || !input.reviewHandoffPrinted || !input.reviewable) {
    return false;
  }
  return true;
}

/**
 * While holding for R after proposal ready, leave the hold when any other
 * watchable active work appears (new inspect/propose). The finished proposal
 * is not in the active list, so otherActiveCount > 0 means new work.
 * Review remains available via Control Inbox / `pairmesh open`.
 */
export function shouldReleaseWatchReviewHoldForOtherWork(input: {
  holdingForReview?: boolean;
  otherActiveCount: number;
}): boolean {
  return input.holdingForReview === true && input.otherActiveCount > 0;
}

export function formatWatchLeavingReviewHoldForNewWork(): string {
  return "New PairMesh work arrived — leaving review hold.";
}

/** Diff helper for poll ticks — only newly observed keys. */
export function diffWatchTimelineKeys(
  previousKeys: ReadonlySet<string>,
  lines: readonly WatchTimelineLine[]
): WatchTimelineLine[] {
  return lines.filter((line) => !previousKeys.has(line.key));
}

/** Resolve poll interval: 1s while live/watching activity, else 3s. */
export function resolveWatchPollIntervalMs(input: {
  watching?: boolean;
  action?: { status?: string } | null;
  work?: WatchCandidate | null;
}): number {
  if (input.watching) {
    return WATCH_POLL_MS;
  }
  const candidate = input.work ?? input.action;
  if (candidate && isWatchWorkLive(candidate as WatchCandidate)) {
    return WATCH_POLL_MS;
  }
  if (input.action && isWatchActionLive(input.action)) {
    return WATCH_POLL_MS;
  }
  return WATCH_IDLE_POLL_MS;
}

/**
 * Assert normal UX strings never leak opaque action IDs.
 * (Power-path commands may still print IDs elsewhere.)
 */
export function watchUxContainsOpaqueActionId(text: string): boolean {
  return /\bact_[0-9a-f-]{8,}\b/i.test(text);
}

/** Assert normal UX strings never leak opaque inspection request IDs. */
export function watchUxContainsOpaqueRequestId(text: string): boolean {
  return /\breq_[0-9a-f-]{8,}\b/i.test(text) || /\binspect_[0-9a-f-]{8,}\b/i.test(text);
}

export function watchUxContainsOpaqueWorkId(text: string): boolean {
  return watchUxContainsOpaqueActionId(text) || watchUxContainsOpaqueRequestId(text);
}
