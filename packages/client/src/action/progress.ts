import {
  appendProgressEvent,
  filterProgressEventsForViewer,
  latestProgressEvent,
  type ActionExecutionRecord,
  type ActionExecutionStatus,
  type ProgressEvent,
  type ProgressPhase
} from "@pairmesh/protocol";
import type { LocalSessionState } from "../session/schemas.js";

export type ProgressViewerRole = "owner" | "requester" | "local_admin";

const STATUS_PHASE: Record<ActionExecutionStatus, ProgressPhase> = {
  requested: "request_received",
  authenticating: "authenticating",
  authorizing: "authorizing",
  approval_required: "awaiting_owner_approval",
  approved: "approved",
  executing: "executing",
  completed: "completed",
  denied: "denied",
  cancelled: "cancelled",
  failed: "failed",
  expired: "expired",
  partially_completed: "partially_completed",
  unknown_outcome: "unknown_outcome"
};

const PHASE_MESSAGE: Partial<Record<ProgressPhase, string>> = {
  request_received: "Request received.",
  authenticating: "Authenticating requester.",
  authorizing: "Checking authorization.",
  awaiting_owner_approval: "Waiting for owner approval.",
  approved: "Approved.",
  proposal_preparing: "Preparing proposal.",
  proposal_ready: "Proposal ready.",
  applying: "Applying approved change.",
  running_named_tests: "Running named tests.",
  executing: "Executing.",
  provider_started: "Local provider started.",
  completed: "Completed.",
  denied: "Denied.",
  cancelled: "Cancelled.",
  failed: "Failed.",
  expired: "Expired.",
  partially_completed: "Partially completed.",
  unknown_outcome: "Outcome unknown."
};

/**
 * Map action status (+ type) to a coarse ProgressPhase.
 * Status-derived events are requester_safe — they mirror wire-visible status.
 */
export function progressPhaseForActionStatus(
  status: ActionExecutionStatus,
  actionType?: string
): ProgressPhase {
  if (status === "executing") {
    if (actionType === "change.propose") {
      return "proposal_preparing";
    }
    if (actionType === "repository.edit") {
      return "applying";
    }
    if (actionType === "tests.run") {
      return "running_named_tests";
    }
    if (actionType === "process.execute") {
      return "running_named_tests";
    }
  }
  if (status === "completed" && actionType === "change.propose") {
    return "proposal_ready";
  }
  return STATUS_PHASE[status];
}

export function resolveActionProgressViewer(
  state: LocalSessionState,
  execution: ActionExecutionRecord
): ProgressViewerRole {
  const localId = state.localParticipant.participant.id;
  if (execution.targetParticipantId === localId) {
    return "owner";
  }
  if (execution.requesterParticipantId === localId) {
    return "requester";
  }
  return "local_admin";
}

export function buildStatusProgressEvent(input: {
  actionId: string;
  status: ActionExecutionStatus;
  actionType?: string;
  timestamp: string;
  visibility?: ProgressEvent["visibility"];
}): ProgressEvent {
  const phase = progressPhaseForActionStatus(input.status, input.actionType);
  const message = PHASE_MESSAGE[phase];
  return {
    operationId: input.actionId,
    phase,
    visibility: input.visibility ?? "requester_safe",
    timestamp: input.timestamp,
    ...(message ? { message } : {})
  };
}

/** Seed progress when a record is first created (may skip intermediate statuses). */
export function seedActionProgressEvents(input: {
  actionId: string;
  status: ActionExecutionStatus;
  actionType: string;
  timestamp: string;
}): ProgressEvent[] {
  let events: ProgressEvent[] = [];
  events = appendProgressEvent(
    events,
    buildStatusProgressEvent({
      actionId: input.actionId,
      status: "requested",
      actionType: input.actionType,
      timestamp: input.timestamp
    })
  );
  if (input.status !== "requested") {
    events = appendProgressEvent(
      events,
      buildStatusProgressEvent({
        actionId: input.actionId,
        status: input.status,
        actionType: input.actionType,
        timestamp: input.timestamp
      })
    );
  }
  if (input.status === "executing") {
    events = appendProgressEvent(events, ownerProviderStarted(input.actionId, input.timestamp));
  }
  return events;
}

/** Append progress for a local status transition on the receiver. */
export function appendTransitionProgress(
  execution: ActionExecutionRecord,
  to: ActionExecutionStatus,
  timestamp: string
): ProgressEvent[] {
  let events = appendProgressEvent(
    execution.progressEvents,
    buildStatusProgressEvent({
      actionId: execution.actionId,
      status: to,
      actionType: execution.actionType,
      timestamp
    })
  );
  if (to === "executing") {
    events = appendProgressEvent(events, ownerProviderStarted(execution.actionId, timestamp));
  }
  return events;
}

/**
 * Requester-side: preserve prior local progress and synthesize requester_safe
 * events from polled wire status deltas (A2A stays status-only).
 */
export function mergeMirroredActionProgress(
  previous: ActionExecutionRecord | undefined,
  mirror: ActionExecutionRecord
): ActionExecutionRecord {
  const timestamp = mirror.updatedAt;
  let events = previous?.progressEvents ? [...previous.progressEvents] : [];

  if (!events.length) {
    events = seedActionProgressEvents({
      actionId: mirror.actionId,
      status: mirror.status,
      actionType: mirror.actionType,
      timestamp
    });
  } else if (!previous || previous.status !== mirror.status) {
    events = appendProgressEvent(
      events,
      buildStatusProgressEvent({
        actionId: mirror.actionId,
        status: mirror.status,
        actionType: mirror.actionType,
        timestamp
      })
    );
  }

  return {
    ...mirror,
    progressEvents: events
  };
}

export function projectProgressForViewer(
  state: LocalSessionState,
  execution: ActionExecutionRecord
): {
  progress: ProgressEvent[];
  latestProgress?: ProgressEvent;
} {
  const viewer = resolveActionProgressViewer(state, execution);
  const progress = filterProgressEventsForViewer(execution.progressEvents, viewer);
  const latest = latestProgressEvent(progress);
  return {
    progress,
    ...(latest ? { latestProgress: latest } : {})
  };
}

function ownerProviderStarted(actionId: string, timestamp: string): ProgressEvent {
  return {
    operationId: actionId,
    phase: "provider_started",
    visibility: "owner_only",
    timestamp,
    message: PHASE_MESSAGE.provider_started
  };
}
