import { describe, expect, it } from "vitest";
import {
  PAIRMESH_FUTURE_CAPABILITIES,
  PAIRMESH_GRANTABLE_CAPABILITIES,
  type ActionExecutionRecord,
  type PeerId
} from "@pairmesh/protocol";
import { enrichActionForControlInbox } from "../control/action-inbox.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import {
  formatProcessCommandDisplay,
  projectOwnerProcessExecution,
  projectOwnerProcessExecutionFromParameters,
  toActionSafeView
} from "./index.js";
import { buildNeedsYouCardModel } from "../../control-web/live-present.js";
import { buildHistoryCardModel } from "../../control-web/history-present.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;

function peer(id: PeerId): LocalSessionState["peers"][number] {
  return {
    participant: { id } as LocalSessionState["peers"][number]["participant"],
    agent: {} as LocalSessionState["peers"][number]["agent"],
    developer: {
      displayName: id === paulId ? "Paul" : "Kelvin"
    } as LocalSessionState["peers"][number]["developer"],
    a2aAgentUrl: "http://127.0.0.1:9/",
    isLocal: false
  };
}

function baseState(localId: PeerId): LocalSessionState {
  const peerId = localId === kelvinId ? paulId : kelvinId;
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-R4M1",
    session: {
      id: "ses_r4m1",
      createdBy: "dev_r4m1",
      createdAt: "2026-09-03T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: { id: localId } as LocalSessionState["localParticipant"]["participant"],
      agent: {} as LocalSessionState["localParticipant"]["agent"],
      developer: {
        displayName: localId === kelvinId ? "Kelvin" : "Paul"
      } as LocalSessionState["localParticipant"]["developer"],
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: [peer(peerId)],
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

function processExecution(overrides: Partial<ActionExecutionRecord> = {}): ActionExecutionRecord {
  return {
    actionId: "act_r4m1_proc",
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    actionType: "process.execute",
    capabilityId: "process.execute",
    status: "approval_required",
    parameters: {
      executable: "pairmesh",
      args: ["doctor"],
      cwd: ".",
      timeoutMs: 120_000,
      maxOutputBytes: 200_000,
      resolvedExecutableIdentity: "a".repeat(64),
      envPolicyDigest: "b".repeat(64),
      workspaceIdentity: "c".repeat(64),
      commandDisplay: "pairmesh doctor"
    },
    parameterDigest: "d".repeat(64),
    mutability: "none",
    createdAt: "2026-09-03T08:00:00.000Z",
    updatedAt: "2026-09-03T08:00:00.000Z",
    permissionRequestId: "perm_r4m1",
    approvalBinding: {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionId: "act_r4m1_proc",
      capabilityId: "process.execute",
      actionType: "process.execute",
      parameterDigest: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z"
    },
    artifactRefs: [
      {
        artifactId: "art_r4m1",
        contentHash: "e".repeat(64),
        artifactType: "process_execution"
      }
    ],
    executorInvocationCount: 0,
    ...overrides
  } as ActionExecutionRecord;
}

describe("R4-M1 — process approval owner projection", () => {
  it("owner projection includes basename, argv, cwd, effective timeout, commandDisplay", () => {
    const view = projectOwnerProcessExecution(processExecution());
    expect(view).toEqual({
      executable: "pairmesh",
      args: ["doctor"],
      cwd: ".",
      timeoutMs: 120_000,
      commandDisplay: "pairmesh doctor"
    });
  });

  it("owner projection never includes absolute path, env, or identity digests", () => {
    const view = projectOwnerProcessExecution(processExecution());
    expect(JSON.stringify(view)).not.toMatch(
      /resolvedExecutableIdentity|envPolicyDigest|\/usr\/|AWS_|TOKEN/
    );
    expect(view && "resolvedExecutableIdentity" in view).toBe(false);
  });

  it("keeps args with spaces and shell metacharacters as exact argv", () => {
    const view = projectOwnerProcessExecutionFromParameters({
      executable: "python3",
      args: ["-c", "print('hello world')", "a&&b", "x|y", "$(oops)"],
      cwd: "packages/api",
      timeoutMs: 30_000
    });
    expect(view?.args).toEqual(["-c", "print('hello world')", "a&&b", "x|y", "$(oops)"]);
    expect(view?.commandDisplay).toContain("hello world");
    expect(formatProcessCommandDisplay("echo", ["&&"])).toContain("&&");
  });

  it("commandDisplay is display-only reconstruction from executable+argv", () => {
    const view = projectOwnerProcessExecutionFromParameters({
      executable: "node",
      args: ["-e", "console.log(1)"],
      cwd: ".",
      timeoutMs: 60_000
      // no commandDisplay — derived
    });
    expect(view?.commandDisplay).toBe(
      formatProcessCommandDisplay("node", ["-e", "console.log(1)"])
    );
  });

  it("shows effective default timeout when bound", () => {
    const view = projectOwnerProcessExecutionFromParameters({
      executable: "node",
      args: ["-e", "1"],
      cwd: ".",
      timeoutMs: 120_000
    });
    expect(view?.timeoutMs).toBe(120_000);
  });

  it("shows explicit timeout when bound", () => {
    const view = projectOwnerProcessExecutionFromParameters({
      executable: "node",
      args: ["-e", "1"],
      cwd: ".",
      timeoutMs: 5_000
    });
    expect(view?.timeoutMs).toBe(5_000);
  });

  it("fail-closed: missing executable / malformed args / missing timeout", () => {
    expect(
      projectOwnerProcessExecutionFromParameters({ args: [], cwd: ".", timeoutMs: 5000 })
    ).toBe(null);
    expect(
      projectOwnerProcessExecutionFromParameters({
        executable: "node",
        args: "not-array" as unknown as string[],
        cwd: ".",
        timeoutMs: 5000
      })
    ).toBe(null);
    expect(
      projectOwnerProcessExecutionFromParameters({
        executable: "node",
        args: [],
        cwd: "."
      })
    ).toBe(null);
    expect(
      projectOwnerProcessExecutionFromParameters({
        executable: "/usr/bin/node",
        args: [],
        cwd: ".",
        timeoutMs: 5000
      })
    ).toBe(null);
    expect(
      projectOwnerProcessExecutionFromParameters({
        executable: "node",
        args: [],
        cwd: "/Users/kelvin/secret",
        timeoutMs: 5000
      })
    ).toBe(null);
  });

  it("toActionSafeView attaches processExecution only for owner/receiver", () => {
    const execution = processExecution();
    const owner = toActionSafeView(baseState(kelvinId), execution);
    expect(owner.processExecution?.executable).toBe("pairmesh");
    expect(owner.processExecution?.args).toEqual(["doctor"]);
    expect(owner.processApprovalDisplayUnavailable).toBeUndefined();
    expect(JSON.stringify(owner)).not.toMatch(/resolvedExecutableIdentity|\/usr\//);

    const requester = toActionSafeView(baseState(paulId), execution);
    expect(requester.processExecution).toBeUndefined();
    expect(requester.processApprovalDisplayUnavailable).toBeUndefined();
  });

  it("owner pending without bound fields marks display unavailable", () => {
    const execution = processExecution({
      parameters: { executable: "pairmesh" } // missing args/timeout/cwd
    });
    const owner = toActionSafeView(baseState(kelvinId), execution);
    expect(owner.processExecution).toBeUndefined();
    expect(owner.processApprovalDisplayUnavailable).toBe(true);
  });

  it("Control inbox fail-closes Approve once when process details missing", () => {
    const execution = processExecution({
      parameters: {}
    });
    const owner = toActionSafeView(baseState(kelvinId), execution);
    const inbox = enrichActionForControlInbox(owner);
    expect(inbox.needsApproval).toBe(true);
    expect(inbox.canApproveOnce).toBe(false);
    expect(inbox.canApproveSession).toBe(false);
    expect(inbox.approvalUnavailableReason).toMatch(/Unable to display command details/i);

    const ok = enrichActionForControlInbox(
      toActionSafeView(baseState(kelvinId), processExecution())
    );
    expect(ok.canApproveOnce).toBe(true);
    expect(ok.processExecution?.commandDisplay).toBe("pairmesh doctor");
    expect(ok.approvalUnavailableReason).toBeUndefined();
  });

  it("Needs You / Live / History present truthful process details from processExecution", () => {
    const inbox = enrichActionForControlInbox(
      toActionSafeView(baseState(kelvinId), processExecution())
    );
    const needs = buildNeedsYouCardModel({
      ...inbox,
      kind: "action",
      workKey: "a:1",
      id: inbox.actionId
    });
    expect(needs.processDetails?.executable).toBe("pairmesh");
    expect(needs.processDetails?.args).toEqual(["doctor"]);
    expect(needs.processDetails?.cwd).toBe(".");
    expect(needs.processDetails?.timeoutMs).toBe(120_000);
    expect(needs.processDetails?.commandDisplay).toBe("pairmesh doctor");
    expect(needs.canApproveOnce).toBe(true);
    expect(needs.allowSession).toBe(false);

    const history = buildHistoryCardModel({
      ...inbox,
      status: "completed",
      terminal: true,
      kind: "action",
      id: inbox.actionId,
      workKey: "a:1"
    });
    expect(history?.question).toContain("pairmesh doctor");
  });

  it("security regression: grantable 6, no shell.execute, no allow_session for process", () => {
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toHaveLength(6);
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toContain("process.execute");
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).not.toContain("shell.execute");
    expect(PAIRMESH_FUTURE_CAPABILITIES).toContain("shell.execute");
    const inbox = enrichActionForControlInbox(
      toActionSafeView(baseState(kelvinId), processExecution())
    );
    expect(inbox.canApproveSession).toBe(false);
  });
});
