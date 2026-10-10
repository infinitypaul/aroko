import { describe, expect, it } from "vitest";
import {
  ActionExecutionRecordSchema,
  CollaborativeTaskSchema,
  PAIRMESH_METADATA_VERSION,
  type ActionExecutionRecord,
  type CollaborativeTask
} from "@pairmesh/protocol";
import { digestParameters } from "../action/digest.js";
import {
  buildRequesterSafeLinkedAction,
  resolveLinkedActionForTask,
  upsertMirroredLinkedAction
} from "./requester-action-mirror.js";
import type { LocalSessionState } from "../session/schemas.js";

function makeProcessAction(
  overrides: Partial<ActionExecutionRecord> & Pick<ActionExecutionRecord, "status">
): ActionExecutionRecord {
  const parameters = overrides.parameters ?? {
    executable: "node",
    args: ["--version"],
    cwd: ".",
    timeoutMs: 30_000
  };
  return ActionExecutionRecordSchema.parse({
    actionId: overrides.actionId ?? "act_11111111-1111-4111-8111-111111111111",
    requesterParticipantId:
      overrides.requesterParticipantId ?? "peer_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetParticipantId:
      overrides.targetParticipantId ?? "peer_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    actionType: overrides.actionType ?? "process.execute",
    capabilityId: overrides.capabilityId ?? "process.execute",
    status: overrides.status,
    parameters,
    parameterDigest: digestParameters(parameters),
    mutability: overrides.mutability ?? "none",
    createdAt: overrides.createdAt ?? "2026-09-12T03:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-12T03:00:01.000Z",
    executorInvocationCount: overrides.executorInvocationCount ?? 0,
    taskId: overrides.taskId ?? "task_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    originProvenance: overrides.originProvenance ?? "receiver_agent",
    ...(overrides.completedAt ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.result ? { result: overrides.result } : {}),
    ...(overrides.error ? { error: overrides.error } : {})
  });
}

function makeTask(overrides?: Partial<CollaborativeTask>): CollaborativeTask {
  return CollaborativeTaskSchema.parse({
    taskId: "task_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    sessionId: "ses_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    requesterParticipantId: "peer_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ownerParticipantId: "peer_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    originalGoal: "Ask for node --version via host tools.",
    status: "blocked_on_action",
    blockedOnActionId: "act_11111111-1111-4111-8111-111111111111",
    childRefs: [
      {
        kind: "action",
        id: "act_11111111-1111-4111-8111-111111111111",
        at: "2026-09-12T03:00:00.000Z"
      }
    ],
    continuationSeq: 1,
    appliedEvents: [],
    createdAt: "2026-09-12T03:00:00.000Z",
    updatedAt: "2026-09-12T03:00:01.000Z",
    ...overrides
  });
}

describe("R5-R1 requester safe linked Action mirror", () => {
  it("projects pending approval without Approve controls or secrets", () => {
    const action = makeProcessAction({ status: "approval_required" });
    const snap = buildRequesterSafeLinkedAction(action, { ownerDisplayName: "Kelvin" });
    expect(snap.ownerDecision).toBe("pending_approval");
    expect(snap.waitingMessage).toMatch(/Kelvin/);
    expect(snap.executableDisplay).toBe("node");
    expect(snap.argsDisplay).toEqual(["--version"]);
    expect(snap.executorInvocationCount).toBe(0);
    expect(JSON.stringify(snap)).not.toMatch(/approve|deny|Bearer|providerSession/i);
  });

  it("projects completed stdout as bounded resultSafe", () => {
    const action = makeProcessAction({
      status: "completed",
      executorInvocationCount: 1,
      completedAt: "2026-09-12T03:00:05.000Z",
      result: {
        actionId: "act_11111111-1111-4111-8111-111111111111",
        status: "completed",
        completedAt: "2026-09-12T03:00:05.000Z",
        outputs: { stdout: "v25.6.1", exitCode: 0 },
        summary: "process.execute completed"
      }
    });
    const snap = buildRequesterSafeLinkedAction(action, { ownerDisplayName: "Kelvin" });
    expect(snap.ownerDecision).toBe("completed");
    expect(snap.resultSafe).toBe("v25.6.1");
    expect(snap.exitCode).toBe(0);
    expect(snap.executorInvocationCount).toBe(1);
    expect(snap.summary).toMatch(/approved/i);
  });

  it("suppresses unsafe stdout instead of leaking paths/secrets", () => {
    const action = makeProcessAction({
      status: "completed",
      executorInvocationCount: 1,
      result: {
        actionId: "act_11111111-1111-4111-8111-111111111111",
        status: "completed",
        completedAt: "2026-09-12T03:00:05.000Z",
        outputs: { stdout: "token=secret /Users/infinitypaul/.ssh/id_rsa", exitCode: 0 }
      }
    });
    const snap = buildRequesterSafeLinkedAction(action);
    expect(snap.resultSuppressed).toBe(true);
    expect(snap.resultSafe).toBe("Action completed. Technical output was not shared.");
    expect(snap.resultSafe).not.toMatch(/secret|Users/);
  });

  it("projects denial with inv=0 and no execution result", () => {
    const action = makeProcessAction({ status: "denied", executorInvocationCount: 0 });
    const snap = buildRequesterSafeLinkedAction(action, { ownerDisplayName: "Kelvin" });
    expect(snap.ownerDecision).toBe("denied");
    expect(snap.summary).toMatch(/denied/i);
    expect(snap.resultSafe).toBeUndefined();
    expect(snap.executorInvocationCount).toBe(0);
  });

  it("projects unknown_outcome without false success/failure", () => {
    const action = makeProcessAction({
      status: "unknown_outcome",
      executorInvocationCount: 1,
      result: {
        actionId: "act_11111111-1111-4111-8111-111111111111",
        status: "unknown_outcome",
        unknownOutcome: true
      }
    });
    const snap = buildRequesterSafeLinkedAction(action);
    expect(snap.ownerDecision).toBe("unknown_outcome");
    expect(snap.unknownOutcome).toBe(true);
    expect(snap.resultSafe).toBe("Execution outcome is uncertain.");
  });

  it("resolves linked action from blockedOnActionId", () => {
    const action = makeProcessAction({ status: "approval_required" });
    const task = makeTask();
    const state = {
      actionExecutions: [action],
      collaborativeTasks: [task]
    } as unknown as LocalSessionState;
    expect(resolveLinkedActionForTask(state, task)?.actionId).toBe(action.actionId);
  });

  it("upserts mirrored linked action idempotently without granting authority fields", () => {
    const action = makeProcessAction({
      status: "completed",
      executorInvocationCount: 1,
      result: {
        actionId: "act_11111111-1111-4111-8111-111111111111",
        status: "completed",
        completedAt: "2026-09-12T03:00:05.000Z",
        outputs: { stdout: "v25.6.1", exitCode: 0 }
      }
    });
    const snap = buildRequesterSafeLinkedAction(action, { ownerDisplayName: "Kelvin" });
    const empty = {
      actionExecutions: [],
      metadataVersion: PAIRMESH_METADATA_VERSION
    } as unknown as LocalSessionState;
    const first = upsertMirroredLinkedAction(empty, snap, {
      requesterParticipantId: action.requesterParticipantId,
      targetParticipantId: action.targetParticipantId,
      taskId: action.taskId!
    });
    expect(first.state.actionExecutions).toHaveLength(1);
    expect(first.execution.executorInvocationCount).toBe(1);
    expect(first.execution.result?.outputs?.stdout).toBe("v25.6.1");
    const second = upsertMirroredLinkedAction(first.state, snap, {
      requesterParticipantId: action.requesterParticipantId,
      targetParticipantId: action.targetParticipantId,
      taskId: action.taskId!
    });
    expect(second.state.actionExecutions).toHaveLength(1);
  });
});
