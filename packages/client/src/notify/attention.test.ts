import { describe, expect, it, vi } from "vitest";
import {
  buildOwnerNotificationPayload,
  sanitizeNotificationText,
  shouldNotifyForStatusTransition
} from "./attention.js";
import { OwnerPresence } from "./owner-presence.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import type { ActionExecutionRecord } from "@pairmesh/protocol";
import { PeerIdSchema, SessionIdSchema } from "@pairmesh/protocol";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

describe("Stage 16 Prompt 4 — attention notifications", () => {
  it("notifies only on human-attention transitions for local target", () => {
    expect(
      shouldNotifyForStatusTransition({
        previousStatus: "requested",
        nextStatus: "approval_required",
        actionType: "repository.edit",
        isLocalTarget: true
      })
    ).toBe("approval_required");

    expect(
      shouldNotifyForStatusTransition({
        previousStatus: "executing",
        nextStatus: "completed",
        actionType: "change.propose",
        isLocalTarget: true
      })
    ).toBe("proposal_ready");

    expect(
      shouldNotifyForStatusTransition({
        previousStatus: "executing",
        nextStatus: "completed",
        actionType: "change.propose",
        isLocalTarget: false
      })
    ).toBeUndefined();

    expect(
      shouldNotifyForStatusTransition({
        previousStatus: "executing",
        nextStatus: "executing",
        actionType: "change.propose",
        isLocalTarget: true
      })
    ).toBeUndefined();
  });

  it("builds privacy-safe payloads without absolute paths or action ids in body", () => {
    const payload = buildOwnerNotificationPayload({
      kind: "approval_required",
      actionId: "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4af99",
      actionType: "repository.edit",
      status: "approval_required",
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      peerDisplayName: "Paul",
      serviceLabel: "payment-service",
      safeSummary: "Fix retry in /Users/paul/Sites/secret/src/retry.ts"
    });
    expect(payload.title).toContain("review");
    expect(payload.body).toContain("Paul");
    expect(payload.body).toContain("payment-service");
    expect(payload.body).not.toMatch(/\/Users\//);
    expect(payload.body).toContain("[path]");
    expect(sanitizeNotificationText("Bearer sk-abc123 act_deadbeef")).not.toMatch(/sk-|act_/);
  });

  it("OwnerPresence delivers deep-link URL for approval_required without browser args", async () => {
    const deliver = vi.fn(async () => ({
      delivered: true,
      method: "bundled-mac-notifier",
      clickOpensUrl: true
    }));
    const openBrowser = vi.fn(async () => true);
    const presence = new OwnerPresence({
      controlBaseUrl: "http://127.0.0.1:9999",
      controlToken: "tok_test",
      deliver,
      openBrowser
      // default openBrowserOnApproval: false
    });

    const state = baseState();
    const next = {
      actionId: "act_018f7b8a-4f31-7cc5-9a7c-fd3394f4af99",
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      capabilityId: "repository.edit",
      status: "approval_required",
      parameters: { instruction: "fix retry" },
      parameterDigest: "a".repeat(64),
      mutability: "mutation",
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      executorInvocationCount: 0
    } as ActionExecutionRecord;

    const kind = await presence.handleActionTransition({ state, next });
    expect(kind).toBe("approval_required");
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]).toHaveLength(1);
    const payload = deliver.mock.calls[0]![0] as { openUrl?: string; body: string };
    expect(payload.openUrl).toContain("http://127.0.0.1:9999/control/web/#");
    expect(payload.openUrl).toContain("token=tok_test");
    expect(payload.openUrl).toContain("action=act_");
    expect(payload.body).not.toMatch(/\/Users\//);
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

function baseState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-NOTIFY1",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
      createdAt: "2026-08-25T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: { id: kelvinId } as LocalSessionState["localParticipant"]["participant"],
      agent: {
        id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        name: "kelvin-agent",
        adapter: "pairmesh.a2a-demo"
      } as LocalSessionState["localParticipant"]["agent"],
      developer: {
        id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
        displayName: "Kelvin"
      } as LocalSessionState["localParticipant"]["developer"],
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: [
      {
        participant: { id: paulId } as LocalSessionState["peers"][number]["participant"],
        agent: {} as LocalSessionState["peers"][number]["agent"],
        developer: {
          id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
          displayName: "Paul"
        } as LocalSessionState["peers"][number]["developer"],
        a2aAgentUrl: "http://127.0.0.1:9/",
        isLocal: false,
        serviceLabel: "payment-service"
      }
    ]
  };
}
