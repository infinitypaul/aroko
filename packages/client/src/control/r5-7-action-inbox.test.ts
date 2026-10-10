/**
 * R5-7 — Control Action inbox collaborative provenance enrichment.
 */
import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  CollaborativeTaskIdSchema,
  PeerIdSchema,
  RECEIVER_AGENT_REQUEST_PROVENANCE
} from "@pairmesh/protocol";
import type { ActionSafeView } from "../action/session-bridge.js";
import { enrichActionForControlInbox } from "./action-inbox.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const taskId = CollaborativeTaskIdSchema.parse("task_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4af21");

function baseView(overrides: Partial<ActionSafeView> = {}): ActionSafeView {
  return {
    actionId,
    status: "approval_required",
    actionType: "process.execute",
    capabilityId: "process.execute",
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:01:00.000Z",
    terminal: false,
    progress: [],
    peer: {
      participantId: paulId,
      displayName: "Paul",
      service: "payment-service"
    },
    taskId,
    originProvenance: RECEIVER_AGENT_REQUEST_PROVENANCE,
    summary: "Run node -e console.log('ok')",
    ...overrides
  };
}

describe("R5-7 enrichActionForControlInbox collaborativeProvenanceLabel", () => {
  it("sets collaborativeProvenanceLabel from receiver_agent_request + peer displayName", () => {
    const enriched = enrichActionForControlInbox(baseView());
    expect(enriched.collaborativeProvenanceLabel).toBe(
      "Requested by your agent while working on Paul's task."
    );
    expect(enriched.collaborativeProvenanceLabel).not.toMatch(/Paul requested/i);
    expect(enriched.collaborativeInteraction).toBe("approve");
    expect(enriched.taskId).toBe(taskId);
    expect(enriched.originProvenance).toBe(RECEIVER_AGENT_REQUEST_PROVENANCE);
  });

  it("omits collaborativeProvenanceLabel when provenance is absent", () => {
    const enriched = enrichActionForControlInbox(baseView({ originProvenance: undefined, taskId }));
    expect(enriched.collaborativeProvenanceLabel).toBeUndefined();
    expect(enriched.collaborativeInteraction).toBe("approve");
  });

  it("uses collaborative fallback when peer displayName missing", () => {
    const enriched = enrichActionForControlInbox(
      baseView({
        peer: {
          participantId: paulId,
          displayName: "",
          service: "payment-service"
        }
      })
    );
    expect(enriched.collaborativeProvenanceLabel).toBe(
      "Requested by your agent while working on a collaborative task."
    );
  });

  it("does not set collaborativeInteraction when not approval_required", () => {
    const enriched = enrichActionForControlInbox(baseView({ status: "executing", taskId }));
    expect(enriched.collaborativeInteraction).toBeUndefined();
    expect(enriched.collaborativeProvenanceLabel).toBe(
      "Requested by your agent while working on Paul's task."
    );
  });
});
