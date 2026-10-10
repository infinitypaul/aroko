import {
  sanitizeProgressSafeMetadata,
  type ProgressActivityKind,
  type ProgressEvent,
  type ProgressPhase,
  type ProgressSafeMetadata
} from "@pairmesh/protocol";
import { formatProgressActivityLabel } from "../progress/activity-display.js";

/** Default tail for receiver-session context (do not dump MAX_PROGRESS_EVENTS=200). */
export const DEFAULT_RECEIVER_ACTIVITY_LIMIT = 15;
/** Hard cap for an optional activityLimit argument. */
export const MAX_RECEIVER_ACTIVITY_LIMIT = 20;

/** Approved keys only for Claude context — never dump arbitrary metadata. */
export type OwnerActivitySafeMetadata = Pick<
  NonNullable<ProgressSafeMetadata>,
  "relativePath" | "query" | "toolName" | "testProfile" | "durationMs"
>;

export interface OwnerActivityItem {
  label: string;
  phase: ProgressPhase;
  timestamp: string;
  activityKind?: ProgressActivityKind;
  safeMetadata?: OwnerActivitySafeMetadata;
}

export interface OwnerActivitySummary {
  activity: OwnerActivityItem[];
  activityBound: number;
  activityTotal: number;
  activityTruncated: boolean;
  coarseState: string;
  proposalReady: boolean;
  reviewRequired: boolean;
}

function progressEventKey(event: ProgressEvent): string {
  if (event.providerEventId) {
    return `id:${event.providerEventId}`;
  }
  if (typeof event.sequence === "number") {
    return `seq:${event.operationId}:${event.sequence}`;
  }
  return `fallback:${event.timestamp}:${event.phase}:${event.activityKind ?? ""}:${event.message ?? ""}`;
}

export function prepareOwnerActivityTimeline(
  events: readonly ProgressEvent[] | undefined
): ProgressEvent[] {
  const list = Array.isArray(events) ? [...events] : [];
  list.sort((a, b) => {
    const sa = typeof a.sequence === "number" ? a.sequence : Number.MAX_SAFE_INTEGER;
    const sb = typeof b.sequence === "number" ? b.sequence : Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return String(a.timestamp).localeCompare(String(b.timestamp));
  });
  const seen = new Set<string>();
  const out: ProgressEvent[] = [];
  for (const event of list) {
    const key = progressEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

/** Human label matching Control Activity presentation (canonical ProgressEvent fields only). */
export function formatOwnerActivityLabel(event: ProgressEvent): string {
  return formatProgressActivityLabel(event, "owner");
}

function projectSafeMetadataForClaude(
  meta: ProgressSafeMetadata | undefined
): OwnerActivitySafeMetadata | undefined {
  const sanitized = sanitizeProgressSafeMetadata(meta);
  if (!sanitized) {
    return undefined;
  }
  const next: OwnerActivitySafeMetadata = {};
  if (sanitized.relativePath) next.relativePath = sanitized.relativePath;
  if (sanitized.query) next.query = sanitized.query;
  if (sanitized.toolName) next.toolName = sanitized.toolName;
  if (sanitized.testProfile) next.testProfile = sanitized.testProfile;
  if (typeof sanitized.durationMs === "number") next.durationMs = sanitized.durationMs;
  return Object.keys(next).length > 0 ? next : undefined;
}

function clampActivityLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RECEIVER_ACTIVITY_LIMIT;
  }
  return Math.min(Math.max(Math.floor(limit), 1), MAX_RECEIVER_ACTIVITY_LIMIT);
}

/**
 * Bound recent owner-visible activity for receiver MCP / active Claude context.
 * Never fabricates events; never includes CoT / raw prompts / absolute paths.
 */
export function summarizeOwnerActivity(input: {
  progress: readonly ProgressEvent[] | undefined;
  status?: string;
  needsApproval?: boolean;
  activityLimit?: number;
}): OwnerActivitySummary {
  const bound = clampActivityLimit(input.activityLimit);
  const timeline = prepareOwnerActivityTimeline(input.progress);
  const truncated = timeline.length > bound;
  const slice = truncated ? timeline.slice(timeline.length - bound) : timeline;

  const activity: OwnerActivityItem[] = slice.map((event) => {
    const safeMetadata = projectSafeMetadataForClaude(event.safeMetadata);
    return {
      label: formatOwnerActivityLabel(event),
      phase: event.phase,
      timestamp: event.timestamp,
      ...(event.activityKind ? { activityKind: event.activityKind } : {}),
      ...(safeMetadata ? { safeMetadata } : {})
    };
  });

  const proposalReady =
    activity.some(
      (item) => item.activityKind === "proposal.ready" || item.phase === "proposal_ready"
    ) || input.status === "approval_required";

  const reviewRequired = Boolean(input.needsApproval) || input.status === "approval_required";

  const latest = activity[activity.length - 1];
  const coarseState =
    latest?.label ?? (input.status ? String(input.status).replace(/_/g, " ") : "No activity yet");

  return {
    activity,
    activityBound: bound,
    activityTotal: timeline.length,
    activityTruncated: truncated,
    coarseState,
    proposalReady,
    reviewRequired
  };
}

/** One-line label for list_requests latest activity. */
export function latestOwnerActivityLabel(
  progress: readonly ProgressEvent[] | undefined
): string | undefined {
  const timeline = prepareOwnerActivityTimeline(progress);
  const latest = timeline[timeline.length - 1];
  return latest ? formatOwnerActivityLabel(latest) : undefined;
}
