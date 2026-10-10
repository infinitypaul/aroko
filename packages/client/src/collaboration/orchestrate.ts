import { PairMeshErrorSchema } from "@pairmesh/protocol";
import type { ActionSafeView } from "../action/session-bridge.js";
import type {
  InspectionRequesterLifecycle,
  PeerInspectionResult,
  SessionManager
} from "../session/manager.js";
import { formatPeerLabel } from "../session/peer-view.js";
import {
  classifyCollaborateIntent,
  formatAmbiguousPeerChoices,
  formatAmbiguousPeerPrompt,
  formatRequesterTerminalOutcome,
  type CollaborateIntent
} from "./ask-intent.js";
import { presentActionHuman, presentInspectionHuman } from "./present.js";

export type CollaborateAskIntent = Exclude<CollaborateIntent, "clarify">;

export interface CollaborateAskInput {
  peerRef: string;
  request: string;
  /** Required for MCP/automation — never infer propose/goal silently. */
  intent: CollaborateAskIntent;
  waitMs?: number;
  /** Optional goal-mode provider override (receiver-local / remote owner). */
  providerId?: "fake" | "claude-code" | "cursor" | "gemini-cli";
}

export interface CollaborateAskResolvedPeer {
  participantId: string;
  displayName: string;
  service?: string;
  label: string;
}

export type CollaborateAskResult =
  | {
      ok: true;
      intent: CollaborateAskIntent;
      peer: CollaborateAskResolvedPeer;
      presentation: string;
      terminal: boolean;
      kind: "inspect";
      inspection: PeerInspectionResult;
      requestId?: string;
      threadId?: string;
      lifecycle?: InspectionRequesterLifecycle;
    }
  | {
      ok: true;
      intent: CollaborateAskIntent;
      peer: CollaborateAskResolvedPeer;
      presentation: string;
      terminal: boolean;
      kind: "propose";
      action: ActionSafeView;
      actionId: string;
      /** Proposal never auto-applies. */
      autoApplied: false;
    }
  | {
      ok: true;
      intent: "goal";
      peer: CollaborateAskResolvedPeer;
      presentation: string;
      terminal: boolean;
      kind: "goal";
      taskId: string;
      status: string;
      continuationSeq?: number;
      pendingInputRequestId?: string;
    }
  | {
      ok: false;
      code: "peer_ambiguous";
      presentation: string;
      matches: Array<{
        participantId: string;
        displayName: string;
        service?: string;
        label: string;
      }>;
    }
  | {
      ok: false;
      code:
        | "peer_not_found"
        | "clarify_required"
        | "error"
        | "action_status_unavailable"
        | "inspection_failed"
        | "inspection_cancelled"
        | "inspection_timed_out"
        | "peer_transport_unavailable"
        | "collaborative_task_unsupported";
      presentation: string;
      details?: unknown;
      requestId?: string;
      threadId?: string;
      lifecycle?: InspectionRequesterLifecycle;
    };

const DEFAULT_WAIT_MS = 60_000;

/**
 * Natural requester orchestration over existing askPeer / requestPeerAction / goal primitives.
 * Does not approve, apply, or invent capabilities.
 */
export async function collaborateAsk(
  manager: SessionManager,
  input: CollaborateAskInput
): Promise<CollaborateAskResult> {
  const request = input.request.trim();
  if (!request) {
    return {
      ok: false,
      code: "clarify_required",
      presentation: "Request text is empty."
    };
  }

  const peer = await resolvePeerForCollaborate(manager, input.peerRef);
  if (!peer.ok) {
    return peer;
  }

  const waitMs = clampWait(input.waitMs);
  const peerLabel = peer.peer.label;

  if (input.intent === "goal") {
    try {
      const localId = await manager.getLocalParticipantId();
      const isLocalOwner = peer.peer.participantId === localId;
      let goalResult = isLocalOwner
        ? await manager.runCollaborativeGoal({
            originalGoal: request,
            ...(input.providerId ? { providerId: input.providerId } : {})
          })
        : await manager.startCollaborativeGoalOnPeer({
            peerRef: peer.peer.participantId,
            originalGoal: request,
            ...(input.providerId ? { providerId: input.providerId } : {})
          });

      // Remote goals async-ack as working; poll short status hops until InputRequest /
      // terminal, continuing through blocked_on_action so Approve Once results mirror (R5-R1).
      if (
        !isLocalOwner &&
        (goalResult.status === "working" || goalResult.status === "blocked_on_action") &&
        waitMs > 0
      ) {
        const waited = await manager.waitForCollaborativeGoalOnPeer({
          peerRef: peer.peer.participantId,
          taskId: goalResult.taskId,
          waitMs
        });
        goalResult = {
          taskId: waited.taskId,
          status: waited.status as typeof goalResult.status,
          ...(typeof waited.continuationSeq === "number"
            ? { continuationSeq: waited.continuationSeq }
            : {}),
          ...(waited.pendingInputRequestId
            ? { pendingInputRequestId: waited.pendingInputRequestId }
            : {}),
          ...(waited.linkedAction ? { linkedAction: waited.linkedAction } : {}),
          ...(waited.resultSummary ? { resultSummary: waited.resultSummary } : {}),
          ...(waited.failureSummary ? { failureSummary: waited.failureSummary } : {}),
          ...(waited.blockedOnActionId ? { blockedOnActionId: waited.blockedOnActionId } : {})
        };
      }

      const status = goalResult.status;
      const linked =
        "linkedAction" in goalResult
          ? (
              goalResult as {
                linkedAction?: import("@pairmesh/protocol").RequesterSafeLinkedAction;
              }
            ).linkedAction
          : undefined;
      const pendingLine =
        "pendingInputRequestId" in goalResult && goalResult.pendingInputRequestId
          ? `pendingInput=${goalResult.pendingInputRequestId}`
          : undefined;
      const linkedLines: string[] = [];
      if (linked) {
        linkedLines.push(
          `linkedAction=${linked.actionId} type=${linked.actionType} status=${linked.status} decision=${linked.ownerDecision}`
        );
        if (linked.executableDisplay) {
          linkedLines.push(
            `command=${linked.executableDisplay}${
              linked.argsDisplay?.length ? ` ${linked.argsDisplay.join(" ")}` : ""
            }`
          );
        }
        if (linked.waitingMessage) {
          linkedLines.push(linked.waitingMessage);
        } else if (linked.summary) {
          linkedLines.push(linked.summary);
        }
        if (linked.resultSafe) {
          linkedLines.push(`result=${linked.resultSafe}`);
        }
        if (typeof linked.executorInvocationCount === "number") {
          linkedLines.push(`inv=${linked.executorInvocationCount}`);
        }
      }
      const resultLine =
        "resultSummary" in goalResult && typeof goalResult.resultSummary === "string"
          ? `taskResult=${goalResult.resultSummary}`
          : "failureSummary" in goalResult && typeof goalResult.failureSummary === "string"
            ? `taskFailure=${goalResult.failureSummary}`
            : undefined;
      const presentation = [
        `Collaborative goal started on ${peerLabel}.`,
        `task=${goalResult.taskId} status=${status}`,
        ...(pendingLine ? [pendingLine] : []),
        ...linkedLines,
        ...(resultLine ? [resultLine] : []),
        "Consequential steps still require owner Approve once / requester answers — never silent authority.",
        ...(status === "waiting_for_input"
          ? ['Answer with: pairmesh task answer <inputRequestId> --text "..."']
          : []),
        ...(status === "blocked_on_action"
          ? ["Waiting for owner Approve Once on the linked action (requester cannot approve)."]
          : []),
        ...(status === "working"
          ? ["Receiver is still working; check pairmesh task pending / task show."]
          : [])
      ].join("\n");

      return {
        ok: true,
        intent: "goal",
        peer: peer.peer,
        presentation,
        terminal: ["completed", "failed", "cancelled", "timed_out"].includes(status),
        kind: "goal",
        taskId: goalResult.taskId,
        status,
        ...(typeof goalResult.continuationSeq === "number"
          ? { continuationSeq: goalResult.continuationSeq }
          : {}),
        ...("pendingInputRequestId" in goalResult && goalResult.pendingInputRequestId
          ? { pendingInputRequestId: goalResult.pendingInputRequestId }
          : {})
      };
    } catch (error) {
      const parsed = PairMeshErrorSchema.safeParse(error);
      if (parsed.success && parsed.data.code === "pairmesh.collaborative_task_unsupported") {
        return {
          ok: false,
          code: "collaborative_task_unsupported",
          presentation:
            parsed.data.message ||
            `${peerLabel} does not support collaborative goals yet. Start the goal on the receiver with pairmesh task run, or upgrade the peer.`,
          details: parsed.data.details
        };
      }
      return {
        ok: false,
        code: "error",
        presentation: error instanceof Error ? error.message : String(error),
        details: error
      };
    }
  }

  if (input.intent === "inspect") {
    let result = await manager.askPeer(peer.peer.participantId, request);
    const workingStatus = !result.completed && "status" in result ? result.status : undefined;
    if (!result.completed && workingStatus === "working") {
      const waited = await manager.waitForInspection(result.requestId, {
        waitMs,
        clampToMcpMax: false
      });
      if (waited.completed && waited.result) {
        result = {
          completed: true,
          threadId: waited.threadId,
          peer: waited.peer ?? peerLabel,
          ...(waited.safePeer ? { safePeer: waited.safePeer } : {}),
          requestId: waited.requestId,
          question: request,
          summary: waited.result.summary ?? "",
          findings: Array.isArray(waited.result.findings) ? waited.result.findings : [],
          references: waited.result.references ?? []
        };
      } else if (
        waited.lifecycle === "failed" ||
        waited.lifecycle === "cancelled" ||
        waited.lifecycle === "timed_out" ||
        waited.lifecycle === "peer_transport_unavailable"
      ) {
        const failCode =
          waited.lifecycle === "cancelled"
            ? "inspection_cancelled"
            : waited.lifecycle === "timed_out"
              ? "inspection_timed_out"
              : waited.lifecycle === "peer_transport_unavailable"
                ? "peer_transport_unavailable"
                : "inspection_failed";
        const presentation = presentInspectionHuman({
          completed: false,
          status:
            waited.lifecycle === "peer_transport_unavailable"
              ? "working"
              : waited.lifecycle === "cancelled"
                ? "cancelled"
                : waited.lifecycle === "timed_out"
                  ? "timed_out"
                  : "failed",
          lifecycle: waited.lifecycle,
          threadId: waited.threadId,
          peer: waited.peer ?? peerLabel,
          ...(waited.safePeer ? { safePeer: waited.safePeer } : {}),
          requestId: waited.requestId,
          question: request,
          message: waited.message ?? `${peerLabel}'s inspection did not complete.`,
          ...(waited.progressEvents?.length ? { progressEvents: waited.progressEvents } : {}),
          ...(waited.error ? { error: waited.error } : {})
        });
        return {
          ok: false,
          code: failCode,
          presentation,
          requestId: waited.requestId,
          threadId: waited.threadId,
          lifecycle: waited.lifecycle,
          details: waited.error
        };
      } else {
        result = {
          completed: false,
          status: "working",
          lifecycle: waited.lifecycle,
          threadId: waited.threadId,
          peer: waited.peer ?? peerLabel,
          ...(waited.safePeer ? { safePeer: waited.safePeer } : {}),
          requestId: waited.requestId,
          question: request,
          ...(waited.progressEvents?.length ? { progressEvents: waited.progressEvents } : {}),
          message:
            waited.message ??
            `${peerLabel} is still investigating. PairMesh will keep the same request — no new ask needed.`
        };
      }
    }

    const presentation = presentInspectionHuman(result);
    const approvalRequired =
      !result.completed && "status" in result && result.status === "approval_required";
    return {
      ok: true,
      intent: "inspect",
      peer: peer.peer,
      presentation,
      terminal: result.completed || approvalRequired,
      kind: "inspect",
      inspection: result,
      requestId: result.requestId,
      threadId: result.threadId,
      ...(!result.completed && "lifecycle" in result && result.lifecycle
        ? { lifecycle: result.lifecycle }
        : result.completed
          ? { lifecycle: "completed" as const }
          : {})
    };
  }

  const wire = await manager.requestPeerAction({
    peerRef: peer.peer.participantId,
    actionType: "change.propose",
    parameters: { instruction: request }
  });

  let view = await manager.getAction(wire.actionId);

  if (!view || typeof view.status !== "string") {
    return {
      ok: false,
      code: "action_status_unavailable",
      presentation:
        "PairMesh could not read the action status for this request. Check pairmesh requests and try again."
    };
  }

  if (!view.terminal) {
    const waited = await manager.waitForAction(view.actionId, {
      waitMs,
      pollIntervalMs: 1500
    });
    view = waited.action;
  }

  if (!view || typeof view.status !== "string") {
    return {
      ok: false,
      code: "action_status_unavailable",
      presentation:
        "PairMesh could not read the action status for this request. Check pairmesh requests and try again."
    };
  }

  let presentation = presentActionHuman(view, peerLabel);
  if (view.status === "approval_required") {
    presentation = `${presentation}\n\n(Proposal never auto-applies — ${peer.peer.displayName} Approves Once in their local Inbox.)`;
  }

  return {
    ok: true,
    intent: "propose",
    peer: peer.peer,
    presentation,
    terminal: Boolean(view.terminal) || view.status === "approval_required",
    kind: "propose",
    action: view,
    actionId: view.actionId,
    autoApplied: false
  };
}

/**
 * Resolve intent for CLI natural language. MCP should pass intent explicitly.
 * Ambiguous inspect+propose/goal language returns clarify (never silent authority).
 */
export function resolveCollaborateIntent(input: {
  request: string;
  force?: CollaborateAskIntent;
}): { intent: CollaborateAskIntent } | { clarify: string } {
  if (input.force) {
    return { intent: input.force };
  }
  const classified = classifyCollaborateIntent(input.request);
  if (classified.intent === "clarify") {
    return {
      clarify:
        classified.reason ??
        "Choose inspect (read-only), propose (suggestion only), or goal (collaborative orchestration)."
    };
  }
  if (classified.intent === "goal") {
    return { intent: "goal" };
  }
  return { intent: classified.intent === "propose" ? "propose" : "inspect" };
}

async function resolvePeerForCollaborate(
  manager: SessionManager,
  peerRef: string
): Promise<
  { ok: true; peer: CollaborateAskResolvedPeer } | Extract<CollaborateAskResult, { ok: false }>
> {
  try {
    const safe = await manager.getSafePeer(peerRef, { skipHealthProbe: true });
    const label = formatPeerLabel({
      displayName: safe.displayName,
      ...(safe.service ? { service: safe.service } : {})
    });
    return {
      ok: true,
      peer: {
        participantId: safe.participantId,
        displayName: safe.displayName,
        ...(safe.service ? { service: safe.service } : {}),
        label
      }
    };
  } catch (error) {
    const parsed = PairMeshErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "pairmesh.peer_ambiguous") {
      const details = parsed.data.details as {
        matches?: Array<{ displayName: string; service?: string; participantId: string }>;
      };
      const matches = formatAmbiguousPeerChoices(details.matches ?? []);
      return {
        ok: false,
        code: "peer_ambiguous",
        presentation: formatAmbiguousPeerPrompt(matches),
        matches
      };
    }
    if (parsed.success && parsed.data.code === "pairmesh.peer_not_found") {
      return {
        ok: false,
        code: "peer_not_found",
        presentation: `Peer not found: ${peerRef}`,
        details: parsed.data.details
      };
    }
    if (parsed.success && parsed.data.code === "pairmesh.peer_unreachable") {
      return {
        ok: false,
        code: "error",
        presentation:
          formatRequesterTerminalOutcome({
            error: { code: parsed.data.code },
            peerLabel: peerRef
          }) ?? `${peerRef} is unavailable right now.`,
        details: parsed.data.details
      };
    }
    return {
      ok: false,
      code: "error",
      presentation: error instanceof Error ? error.message : String(error),
      details: error
    };
  }
}

function clampWait(waitMs: number | undefined): number {
  if (waitMs === undefined || !Number.isFinite(waitMs)) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(Math.max(Math.floor(waitMs), 1_000), 120_000);
}
