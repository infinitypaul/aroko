import { describe, expect, it } from "vitest";
import {
  buildExecutionProviderSnapshot,
  resolveStoredProviderDisplayName
} from "./provider-snapshot.js";
import { enrichActionForControlInbox } from "../control/action-inbox.js";
import {
  toInspectionSafeView,
  createReceiverInspectionExecution
} from "../session/receiver-inspections.js";
import type { LocalSessionState } from "../session/schemas.js";

describe("Stage 20 Prompt 5 — execution provider snapshot", () => {
  it("captures stable presentation identity without secrets", () => {
    const snap = buildExecutionProviderSnapshot({
      providerId: "claude-code",
      displayName: "Claude Code"
    });
    expect(snap).toEqual({
      executionProviderId: "claude-code",
      executionProviderDisplayName: "Claude Code"
    });
  });

  it("prefers stored snapshot over current config enrichment", () => {
    const view = enrichActionForControlInbox(
      {
        actionId: "act_1",
        status: "completed",
        actionType: "change.propose",
        capabilityId: "change.propose",
        requesterParticipantId: "peer_k",
        targetParticipantId: "peer_p",
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:01:00.000Z",
        terminal: true,
        progress: [],
        providerDisplayName: "Claude Code",
        executionProviderId: "claude-code"
      },
      { codingAgentProviderId: "cursor" }
    );
    expect(view.providerDisplayName).toBe("Claude Code");
  });

  it("survives inspection safe view projection", () => {
    const record = createReceiverInspectionExecution({
      requestId: "req_1",
      threadId: "thr_00000000-0000-4000-8000-000000000001",
      requesterPeerId: "peer_00000000-0000-4000-8000-000000000002",
      requesterPeerName: "Kelvin",
      turnNumber: 1,
      question: "Where is retry?",
      now: "2026-09-01T10:00:00.000Z",
      executionProviderId: "claude-code",
      executionProviderDisplayName: "Claude Code"
    });
    const state = {
      peers: [],
      inspectionExecutions: [record]
    } as unknown as LocalSessionState;
    const view = toInspectionSafeView(state, record);
    expect(view.providerDisplayName).toBe("Claude Code");
    expect(view.executionProviderId).toBe("claude-code");
    expect(
      resolveStoredProviderDisplayName({
        executionProviderId: "gemini-cli",
        executionProviderDisplayName: "Gemini CLI"
      })
    ).toBe("Gemini CLI");
  });
});
