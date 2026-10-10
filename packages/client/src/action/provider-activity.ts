import type {
  InspectionProgressEvent,
  ProgressActivityKind,
  ProgressEvent,
  ProgressPhase
} from "@pairmesh/protocol";
import {
  activityKindToProgressPhase,
  resolveProgressVisibility,
  sanitizeProgressSafeMetadata
} from "@pairmesh/protocol";
import type { ProviderActivityEvent } from "../coding-agent/provider-visibility.js";

const ACTIVITY_TO_PROGRESS: Record<ProviderActivityEvent["phase"], ProgressPhase> = {
  provider_started: "provider_started",
  investigating: "investigating",
  reading_searching: "reading_searching",
  proposal_preparing: "proposal_preparing",
  proposal_ready: "proposal_ready",
  executing: "executing",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
};

/**
 * Map a provider-neutral activity event into canonical ProgressEvent.
 * Default visibility is owner_only — tool/file detail must not leak to requester.
 * File/search/tool activityKind always forces owner_only.
 */
export function mapProviderActivityToProgressEvent(input: {
  actionId: string;
  event: ProviderActivityEvent;
  timestamp: string;
}): ProgressEvent {
  const activityKind = input.event.activityKind;
  const phase = activityKind
    ? activityKindToProgressPhase(activityKind)
    : ACTIVITY_TO_PROGRESS[input.event.phase];
  const visibility = resolveProgressVisibility({
    activityKind,
    visibility: input.event.visibility
  });
  const safeMetadata = sanitizeProgressSafeMetadata(
    input.event.safeMetadata as Record<string, unknown> | undefined
  );

  return {
    operationId: input.actionId,
    phase,
    visibility,
    timestamp: input.timestamp,
    ...(input.event.message ? { message: input.event.message } : {}),
    ...(activityKind ? { activityKind } : {}),
    ...(safeMetadata ? { safeMetadata } : {}),
    ...(typeof input.event.sequence === "number" ? { sequence: input.event.sequence } : {}),
    ...(input.event.providerEventId ? { providerEventId: input.event.providerEventId } : {})
  };
}

const INSPECTION_PHASE_TO_ACTIVITY: Record<
  InspectionProgressEvent["phase"],
  {
    phase: ProgressPhase;
    activityKind?: ProgressActivityKind;
    visibility: ProgressEvent["visibility"];
  }
> = {
  accepted: { phase: "request_received", visibility: "requester_safe" },
  "peer-reachable": { phase: "authenticating", visibility: "requester_safe" },
  "coding-agent-starting": {
    phase: "provider_started",
    activityKind: "worker.started",
    visibility: "requester_safe"
  },
  inspecting: { phase: "investigating", visibility: "requester_safe" },
  completed: {
    phase: "completed",
    activityKind: "worker.completed",
    visibility: "requester_safe"
  },
  failed: { phase: "failed", activityKind: "worker.failed", visibility: "requester_safe" },
  timed_out: { phase: "failed", activityKind: "worker.failed", visibility: "requester_safe" },
  cancelled: { phase: "cancelled", visibility: "requester_safe" }
};

export function mapInspectionProgressToProgressEvent(input: {
  operationId: string;
  event: InspectionProgressEvent;
  timestamp: string;
  providerEventId?: string;
  sequence?: number;
}): ProgressEvent {
  const mapped = INSPECTION_PHASE_TO_ACTIVITY[input.event.phase];
  const safeMetadata = sanitizeProgressSafeMetadata(
    typeof input.event.elapsedMs === "number" ? { durationMs: input.event.elapsedMs } : undefined
  );
  return {
    operationId: input.operationId,
    phase: mapped.phase,
    visibility: mapped.visibility,
    timestamp: input.timestamp,
    ...(input.event.message ? { message: input.event.message } : {}),
    ...(mapped.activityKind ? { activityKind: mapped.activityKind } : {}),
    ...(safeMetadata ? { safeMetadata } : {}),
    ...(typeof input.sequence === "number" ? { sequence: input.sequence } : {}),
    ...(input.providerEventId ? { providerEventId: input.providerEventId } : {})
  };
}

/** Convenience: InspectionProgressEvent → ProviderActivityEvent for shared emit paths. */
export function mapInspectionProgressToProviderActivity(
  event: InspectionProgressEvent
): ProviderActivityEvent {
  const mapped = INSPECTION_PHASE_TO_ACTIVITY[event.phase];
  let phase: ProviderActivityEvent["phase"] = "investigating";
  switch (mapped.phase) {
    case "provider_started":
      phase = "provider_started";
      break;
    case "investigating":
    case "reading_searching":
      phase = "investigating";
      break;
    case "proposal_preparing":
      phase = "proposal_preparing";
      break;
    case "proposal_ready":
      phase = "proposal_ready";
      break;
    case "executing":
    case "running_named_tests":
    case "applying":
      phase = "executing";
      break;
    case "completed":
      phase = "completed";
      break;
    case "failed":
      phase = "failed";
      break;
    case "cancelled":
      phase = "cancelled";
      break;
    default:
      phase = "investigating";
  }

  return {
    phase,
    ...(mapped.activityKind ? { activityKind: mapped.activityKind } : {}),
    ...(event.message ? { message: event.message } : {}),
    visibility: mapped.visibility === "requester_safe" ? "requester_safe" : "owner_only",
    ...(typeof event.elapsedMs === "number"
      ? { safeMetadata: { durationMs: event.elapsedMs } }
      : {})
  };
}
