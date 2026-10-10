
import type { ProgressEvent } from "@pairmesh/protocol";
import { formatActivityTimelineText } from "../progress/activity-display.js";

export type CollaborateIntent = "inspect" | "propose" | "clarify" | "goal";

export interface CollaborateIntentResult {
  intent: CollaborateIntent;
  /** When clarify, human-readable choices. */
  reason?: string;
}

/**
 * Classify user text into inspect / propose / goal / clarify.
 * Ambiguous inspect+mutate defaults to clarify (never silent authority).
 * Explicit goal/consequential workflow language → goal when clear.
 * Never auto-apply.
 */
export function classifyCollaborateIntent(request: string): CollaborateIntentResult {
  const text = request.trim().toLowerCase();
  if (!text) {
    return { intent: "clarify", reason: "Request text is empty." };
  }

  const goalSignals =
    /\b(install|initialize|initialise|set\s*up|setup|run (the )?(build|tests?|script|command)|build (and|the)|npm i(nstall)?|pnpm i(nstall)?|yarn add|prepare .+ for|get .+ (working|running)|make .+ (work|run))\b/;
  const proposeSignals =
    /\b(fix|propose|suggest a (fix|change)|patch|implement|repair|change the|update the|rewrite|refactor|mutate|apply (the )?change)\b/;
  const inspectSignals =
    /\b(check|investigate|why|explain|look into|inspect|find out|diagnose|what('s| is) wrong|trace)\b/;

  const wantsGoal = goalSignals.test(text);
  const wantsPropose = proposeSignals.test(text);
  const wantsInspect = inspectSignals.test(text);

  // Uncertain inspect + mutate/goal → clarify (never silent authority).
  if (wantsInspect && (wantsPropose || wantsGoal)) {
    return {
      intent: "clarify",
      reason:
        "This sounds like both investigation and a consequential change. Choose inspect (read-only), propose (suggestion only — owner still Approves Once), or goal (collaborative orchestration with Approve once)."
    };
  }

  if (wantsGoal && !wantsInspect) {
    return { intent: "goal" };
  }

  if (wantsPropose && !wantsInspect) {
    return { intent: "propose" };
  }

  if (wantsInspect || (!wantsPropose && !wantsGoal)) {
    return { intent: "inspect" };
  }
  return { intent: "inspect" };
}

export interface AmbiguousPeerMatch {
  displayName: string;
  service?: string;
  participantId: string;
  label: string;
}

export function formatAmbiguousPeerChoices(
  matches: Array<{ displayName: string; service?: string; participantId: string }>
): AmbiguousPeerMatch[] {
  return matches.map((match) => ({
    ...match,
    label: match.service ? `${match.displayName} · ${match.service}` : match.displayName
  }));
}

export function formatAmbiguousPeerPrompt(matches: AmbiguousPeerMatch[]): string {
  const lines = matches.map((match, index) => `${index + 1}. ${match.label}`);
  return `I found ${matches.length} matches:\n\n${lines.join("\n")}\n\nWhich one?`;
}

/** Phase → concise Paul-facing label. Never invents phases; caller only passes real ones. */
const REQUESTER_PHASE_LABEL: Record<string, string> = {
  request_received: "Request delivered",
  authenticating: "Connecting",
  authorizing: "Authorizing",
  provider_started: "Started",
  investigating: "Investigating",
  reading_searching: "Investigating",
  proposal_preparing: "Preparing change…",
  proposal_ready: "Waiting for approval",
  awaiting_owner_approval: "Waiting for approval",
  approved: "Approved",
  applying: "Applying",
  running_named_tests: "Testing",
  executing: "Working",
  completed: "Completed",
  denied: "Denied",
  cancelled: "Cancelled",
  failed: "Failed",
  expired: "Expired",
  partially_completed: "Partially completed",
  unknown_outcome: "Outcome unknown"
};

function phaseLabelForRequester(phase: string | undefined, peerLabel?: string): string | undefined {
  if (!phase) {
    return undefined;
  }
  if (phase === "awaiting_owner_approval") {
    const peer = peerLabel?.trim();
    return peer ? `Waiting for ${peer}'s approval` : "Waiting for approval";
  }
  if (phase === "denied") {
    const peer = peerLabel?.trim();
    return peer ? `${peer} denied the request` : "Denied";
  }
  return REQUESTER_PHASE_LABEL[phase];
}

/**
 * Human-readable requester-safe progress line from canonical phase/status.
 * Prefers phase templates over raw messages so owner file/tool copy cannot leak via message.
 * Does not invent phases — unknown phase falls through to status / safe message.
 */
export function formatRequesterProgressLine(input: {
  phase?: string;
  message?: string;
  status?: string;
  peerLabel?: string;
}): string {
  const peer = input.peerLabel ?? "Peer";
  const fromPhase = phaseLabelForRequester(input.phase, peer);
  if (fromPhase) {
    return fromPhase;
  }

  switch (input.status) {
    case "requested":
      return "Request delivered";
    case "approval_required":
      return phaseLabelForRequester("awaiting_owner_approval", peer) ?? "Waiting for approval";
    case "executing":
    case "approved":
      return "Working";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "denied":
      return phaseLabelForRequester("denied", peer) ?? "Denied";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    default:
      break;
  }

  const message = input.message?.trim();
  if (message && !/^(Reading|Searching|Using)\b/i.test(message)) {
    return message;
  }
  return input.status ? `Status: ${input.status.replace(/_/g, " ")}` : "Working";
}

export function formatRequesterProgressTimeline(input: {
  progress: ReadonlyArray<{
    phase?: string;
    message?: string;
    activityKind?: string;
    operationId?: string;
    visibility?: string;
    timestamp?: string;
    sequence?: number;
    safeMetadata?: Record<string, unknown>;
  }>;
  peerLabel?: string;
  status?: string;
  providerDisplayName?: string;
}): string {
  const peer = input.peerLabel ?? "Peer";
  const asEvents = (input.progress ?? []).map((event, index) => ({
    operationId: event.operationId ?? "req_display",
    phase: (event.phase ?? "investigating") as ProgressEvent["phase"],
    visibility: (event.visibility === "owner_only" ? "owner_only" : "requester_safe") as
      "requester_safe" | "owner_only",
    timestamp: event.timestamp ?? "2026-01-01T00:00:00.000Z",
    ...(event.message ? { message: event.message } : {}),
    ...(event.activityKind
      ? { activityKind: event.activityKind as ProgressEvent["activityKind"] }
      : {}),
    ...(typeof event.sequence === "number" ? { sequence: event.sequence } : { sequence: index }),
    ...(event.safeMetadata
      ? { safeMetadata: event.safeMetadata as ProgressEvent["safeMetadata"] }
      : {})
  })) as ProgressEvent[];

  return formatActivityTimelineText({
    progress: asEvents,
    viewer: "requester",
    header: input.providerDisplayName ? `${peer} — ${input.providerDisplayName}` : peer,
    status: input.status
  });
}

/**
 * Clear requester-facing terminal / attention outcomes.
 * Preserves useful error text without owner-private activity.
 */
export function formatRequesterTerminalOutcome(input: {
  status?: string;
  peerLabel?: string;
  error?: { code?: string; message?: string };
}): string | undefined {
  const peer = input.peerLabel ?? "Peer";
  const code = input.error?.code ?? "";
  if (code === "pairmesh.peer_unreachable" || /peer_unreachable/i.test(code)) {
    return `${peer} is unavailable right now. Try again when they are back on the mesh.`;
  }

  switch (input.status) {
    case "completed":
      return "Done";
    case "denied":
      return `${peer} denied the request.`;
    case "expired":
      return "This request expired before it was completed. Ask again with a fresh request.";
    case "failed": {
      const detail = input.error?.message?.trim();
      if (detail && !/^(Reading|Searching|Using)\b/i.test(detail)) {
        return `Failed: ${detail}`;
      }
      return "The request failed.";
    }
    case "cancelled":
      return "Cancelled.";
    default:
      return undefined;
  }
}
