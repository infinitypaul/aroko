import { describe, expect, it } from "vitest";
import {
  authorizeInspection,
  decidePermissionRequest,
  ensureDefaultGrants,
  markPermissionAudited,
  permissionAlreadyAudited,
  setGrantPolicy
} from "./capabilities.js";
import { createSessionSecurity } from "./session-security.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import type { PeerId } from "@pairmesh/protocol";

const peerId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;

function baseState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ABCDEF",
    session: {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-19T19:00:00.000Z",
      status: "active"
    },
    localParticipant: {} as LocalSessionState["localParticipant"],
    peers: [],
    inspectionThreads: [],
    inspectionExecutions: [],
    sessionSecurity: createSessionSecurity(),
    permissionRequests: [],
    actionExecutions: [],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: []
  };
}

describe("authorizeInspection audit markers", () => {
  it("marks only the first pending creation as created", () => {
    let state = baseState();
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, peerId)
    };
    state = setGrantPolicy(state, peerId, "repository.inspect", "approval_required");

    const first = authorizeInspection(state, {
      participantId: peerId,
      correlationRequestId: "req_1"
    });
    expect(first.outcome.status).toBe("approval_required");
    if (first.outcome.status !== "approval_required") {
      return;
    }
    expect(first.outcome.created).toBe(true);

    const second = authorizeInspection(first.state, {
      participantId: peerId,
      correlationRequestId: "req_1"
    });
    expect(second.outcome.status).toBe("approval_required");
    if (second.outcome.status !== "approval_required") {
      return;
    }
    expect(second.outcome.created).toBe(false);
    expect(second.outcome.permissionRequest.permissionRequestId).toBe(
      first.outcome.permissionRequest.permissionRequestId
    );
  });

  it("allow-once remains bound to the original requestId", () => {
    let state = baseState();
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, peerId)
    };
    state = setGrantPolicy(state, peerId, "repository.inspect", "approval_required");

    const pending = authorizeInspection(state, {
      participantId: peerId,
      correlationRequestId: "req_once"
    });
    if (pending.outcome.status !== "approval_required") {
      throw new Error("expected approval_required");
    }

    const decided = decidePermissionRequest(
      pending.state,
      pending.outcome.permissionRequest.permissionRequestId,
      "allow-once"
    );
    const allowed = authorizeInspection(decided.state, {
      participantId: peerId,
      correlationRequestId: "req_once"
    });
    expect(allowed.outcome).toMatchObject({ status: "allowed", source: "allow_once" });

    const other = authorizeInspection(allowed.state, {
      participantId: peerId,
      correlationRequestId: "req_other"
    });
    expect(other.outcome.status).toBe("approval_required");
  });

  it("deny is terminal and alreadyAudited after decide", () => {
    let state = baseState();
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, peerId)
    };
    state = setGrantPolicy(state, peerId, "repository.inspect", "approval_required");

    const pending = authorizeInspection(state, {
      participantId: peerId,
      correlationRequestId: "req_deny"
    });
    if (pending.outcome.status !== "approval_required") {
      throw new Error("expected approval_required");
    }

    const decided = decidePermissionRequest(
      pending.state,
      pending.outcome.permissionRequest.permissionRequestId,
      "deny"
    );
    expect(permissionAlreadyAudited(decided.request, "denied")).toBe(true);

    const denied = authorizeInspection(decided.state, {
      participantId: peerId,
      correlationRequestId: "req_deny"
    });
    expect(denied.outcome.status).toBe("denied");
    if (denied.outcome.status !== "denied") {
      return;
    }
    expect(denied.outcome.alreadyAudited).toBe(true);
  });

  it("markPermissionAudited is idempotent for the same event", () => {
    let state = baseState();
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, peerId)
    };
    state = setGrantPolicy(state, peerId, "repository.inspect", "approval_required");
    const pending = authorizeInspection(state, {
      participantId: peerId,
      correlationRequestId: "req_audit"
    });
    if (pending.outcome.status !== "approval_required") {
      throw new Error("expected approval_required");
    }
    const id = pending.outcome.permissionRequest.permissionRequestId;
    const once = markPermissionAudited(pending.state, id, "requested");
    const twice = markPermissionAudited(once, id, "requested");
    const request = twice.permissionRequests?.find((entry) => entry.permissionRequestId === id);
    expect(request?.auditedEvents).toEqual(["requested"]);
  });
});

describe("Stage 15 repository.edit policy lock", () => {
  it("rejects allow_session for repository.edit", () => {
    let state = baseState();
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, peerId)
    };
    expect(() => setGrantPolicy(state, peerId, "repository.edit", "allow_session")).toThrow(
      expect.objectContaining({ code: "pairmesh.capability_not_allowed" })
    );
  });
});
