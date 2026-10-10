
export type HumanAttentionKind =
  "incoming_request" | "approval_required" | "proposal_ready" | "action_failed";

export interface HumanAttentionEvent {
  kind: HumanAttentionKind;
  actionId: string;
  actionType: string;
  status: string;
  requesterParticipantId: string;
  targetParticipantId: string;
  /** Safe peer display name when known. */
  peerDisplayName?: string;
  /** Safe service label when known. */
  serviceLabel?: string;
  /** Short safe summary (already sanitized). */
  safeSummary?: string;
}

export interface OwnerNotificationPayload {
  title: string;
  body: string;
  /** Loopback Control deep-link URL (hash includes token). */
  openUrl?: string;
  kind: HumanAttentionKind;
  actionId: string;
}

const MAX_SUMMARY = 120;

export function buildOwnerNotificationPayload(
  event: HumanAttentionEvent,
  options?: { openUrl?: string }
): OwnerNotificationPayload {
  const who = event.peerDisplayName?.trim() || "A peer";
  const service = event.serviceLabel?.trim();
  const where = service ? `${who} · ${service}` : who;
  const actionHint = humanizeActionType(event.actionType);
  let title = "PairMesh";
  let body: string;

  switch (event.kind) {
    case "approval_required":
      title = "PairMesh — review needed";
      body = `${where} requested ${actionHint}.`;
      break;
    case "proposal_ready":
      title = "PairMesh — proposal ready";
      body = `${where}: ${actionHint} is ready to review.`;
      break;
    case "action_failed":
      title = "PairMesh — action failed";
      body = `${where}: ${actionHint} failed.`;
      break;
    case "incoming_request":
    default:
      title = "PairMesh — new request";
      body = `${where} sent ${actionHint}.`;
      break;
  }

  if (event.safeSummary?.trim()) {
    const clipped = event.safeSummary.trim().slice(0, MAX_SUMMARY);
    body = `${body} ${clipped}`;
  }

  return {
    title,
    body: sanitizeNotificationText(body),
    kind: event.kind,
    actionId: event.actionId,
    ...(options?.openUrl ? { openUrl: options.openUrl } : {})
  };
}

export function sanitizeNotificationText(value: string): string {
  return value
    .replace(/\/(?:Users|home|tmp|var|private)\/[^\s]+/gi, "[path]")
    .replace(/\b(?:sk-|Bearer\s+)\S+/gi, "[redacted]")
    .replace(/\bact_[a-z0-9_-]+\b/gi, "[action]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function humanizeActionType(actionType: string): string {
  switch (actionType) {
    case "repository.edit":
      return "a change apply";
    case "change.propose":
      return "a change proposal";
    case "tests.run":
      return "named tests";
    case "process.execute":
      return "a command";
    default:
      return "work";
  }
}

export function shouldNotifyForStatusTransition(input: {
  previousStatus?: string;
  nextStatus: string;
  actionType: string;
  isLocalTarget: boolean;
}): HumanAttentionKind | undefined {
  if (!input.isLocalTarget) {
    return undefined;
  }
  if (input.nextStatus === "approval_required" && input.previousStatus !== "approval_required") {
    return "approval_required";
  }
  if (
    input.nextStatus === "completed" &&
    input.actionType === "change.propose" &&
    input.previousStatus !== "completed"
  ) {
    return "proposal_ready";
  }
  if (input.nextStatus === "failed" && input.previousStatus !== "failed") {
    return "action_failed";
  }
  if (
    input.nextStatus === "requested" &&
    (!input.previousStatus || input.previousStatus === "requested")
  ) {
    // Only when freshly created as requested (rare for receiver-facing path)
    return "incoming_request";
  }
  return undefined;
}
