import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  PAIRMESH_GRANTABLE_CAPABILITIES,
  PAIRMESH_HOST_REQUEST_TOOLS,
  PeerIdSchema,
  RECEIVER_AGENT_REQUEST_PROVENANCE,
  RequestProcessExecutionArgsSchema,
  RequestRequesterInputArgsSchema,
  SessionIdSchema
} from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import type { PairMeshProcessExecutionConfig } from "../local-config/schema.js";
import { ActionService } from "../action/service.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import {
  CodingAgentProposalGenerator,
  PROPOSAL_FORMAT_V1,
  buildCanonicalProposalBytes,
  type ProposalArtifactV1
} from "../action/proposal/index.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { LocalStateStore } from "../state/store.js";
import { CollaborativeTaskService } from "./collaborative-task-service.js";
import { InputRequestService } from "./input-request-service.js";
import { HostRequestBridge, mintHostToolCallId } from "./host-request-service.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

function baseState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-R54TST",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-09-04T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: kelvinId,
        sessionId,
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: "2026-09-04T12:00:00.000Z"
      },
      agent: {
        id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        name: "kelvin-agent",
        adapter: "pairmesh.a2a-demo"
      },
      developer: {
        id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        displayName: "Kelvin"
      },
      a2aAgentUrl: "http://127.0.0.1:4502/",
      isLocal: true
    },
    peers: [
      {
        participant: {
          id: paulId,
          sessionId,
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          joinedAt: "2026-09-04T12:00:00.000Z"
        },
        agent: {
          id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          name: "paul-agent",
          adapter: "pairmesh.a2a-demo"
        },
        developer: {
          id: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          displayName: "Paul"
        },
        a2aAgentUrl: "http://127.0.0.1:4501/",
        isLocal: false
      }
    ],
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

function grant(
  state: LocalSessionState,
  capability:
    | "change.propose"
    | "repository.edit"
    | "tests.run"
    | "process.execute"
    | "repository.inspect"
    | "repository.source_references",
  policy: "approval_required" | "deny" | "allow_session"
): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
  };
  next = setGrantPolicy(next, paulId, capability, policy);
  return next;
}

async function harness() {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r5-4-ws-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "hello.txt"), "hello\n", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-r5-4-state-"));
  const stateFilePath = join(dir, "state.json");
  const store = new LocalStateStore({ stateFilePath });
  let processConfig: PairMeshProcessExecutionConfig = {
    maxConcurrent: 1,
    defaultTimeoutMs: 15_000,
    maxTimeoutMs: 60_000,
    maxOutputBytes: 8_192,
    env: {}
  };
  const actionService = new ActionService({
    stateFilePath,
    workspaceRoot: workspace,
    proposalGenerator: new CodingAgentProposalGenerator(new FakeCodingAgentAdapter(workspace)),
    loadProcessConfig: () => processConfig,
    loadTestsConfig: async () => ({
      maxConcurrent: 1,
      sessionAllowedProfiles: [],
      profiles: {
        unit: {
          executable: "node",
          args: ["-e", "console.log('ok')"],
          timeoutMs: 15_000,
          maxOutputBytes: 8_192
        }
      }
    })
  });
  await store.save(grant(baseState(), "repository.inspect", "allow_session"));
  const tasks = new CollaborativeTaskService(store);
  const inputs = new InputRequestService(store);
  const bridge = new HostRequestBridge({ stateStore: store, actionService });
  const task = await tasks.createTask({
    sessionId,
    requesterParticipantId: paulId,
    ownerParticipantId: kelvinId,
    originalGoal: "install is-odd"
  });
  return {
    store,
    actionService,
    tasks,
    inputs,
    bridge,
    task,
    workspace,
    stateFilePath,
    trusted: (hostToolCallId = mintHostToolCallId()) => ({
      taskId: task.taskId,
      sessionId,
      requesterParticipantId: paulId,
      ownerParticipantId: kelvinId,
      hostToolCallId
    })
  };
}

describe("R5-4 host-mediated request bridge", () => {
  it("A: registers five tools; rejects authority fields in args; permissions remain 6", () => {
    expect(PAIRMESH_HOST_REQUEST_TOOLS).toEqual([
      "request_requester_input",
      "request_change_proposal",
      "request_repository_edit",
      "request_tests_run",
      "request_process_execution"
    ]);
    expect(() =>
      RequestRequesterInputArgsSchema.parse({
        question: "ok?",
        ownerParticipantId: "peer_x",
        approved: true
      })
    ).toThrow();
    expect(() =>
      RequestProcessExecutionArgsSchema.parse({
        executable: "npm",
        args: ["install", "is-odd"],
        controlToken: "secret"
      })
    ).toThrow();
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toHaveLength(6);
  });

  it("B: Fake worker request_requester_input → R5-3 InputRequest; answer creates no Action", async () => {
    const { bridge, inputs, tasks, store, trusted } = await harness();
    const result = await bridge.invoke("request_requester_input", trusted(), {
      question: "This project is not initialized. Should I initialize it?",
      options: ["Yes", "No"]
    });
    expect(result.status).toBe("waiting_for_requester");
    if (result.status !== "waiting_for_requester") {
      return;
    }
    const task = await tasks.getTask(result.taskId);
    expect(task?.status).toBe("waiting_for_input");
    expect(task?.pendingInputRequestId).toBe(result.inputRequestId);

    const answered = await inputs.answerInputRequest({
      taskId: result.taskId,
      inputRequestId: result.inputRequestId,
      answer: "Yes",
      answeringParticipantId: paulId
    });
    expect(answered.task.status).toBe("working");
    expect(answered.task.continuationSeq).toBe(1);
    expect((await store.load())?.actionExecutions ?? []).toHaveLength(0);
  });

  it("F: Fake worker request_process_execution → R4 Action; spawn 0 until Approve Once; duplicate idempotent", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);

    const callId = mintHostToolCallId();
    const result = await h.bridge.invoke("request_process_execution", h.trusted(callId), {
      executable: "node",
      args: ["-e", "console.log('R5_4_OK')"]
    });
    expect(result.status).toBe("waiting_for_owner");
    if (result.status !== "waiting_for_owner") {
      return;
    }

    const task = await h.tasks.getTask(result.taskId);
    expect(task?.status).toBe("blocked_on_action");
    expect(task?.blockedOnActionId).toBe(result.actionId);
    expect(task?.childRefs.filter((r) => r.kind === "action")).toHaveLength(1);

    const execution = h.actionService.findExecution((await h.store.load())!, result.actionId);
    expect(execution?.status).toBe("approval_required");
    expect(execution?.taskId).toBe(result.taskId);
    expect(execution?.originProvenance).toBe(RECEIVER_AGENT_REQUEST_PROVENANCE);
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);

    const dup = await h.bridge.invoke("request_process_execution", h.trusted(callId), {
      executable: "node",
      args: ["-e", "console.log('R5_4_OK')"]
    });
    expect(dup.status).toBe("waiting_for_owner");
    if (dup.status === "waiting_for_owner") {
      expect(dup.actionId).toBe(result.actionId);
    }
    expect((await h.store.load())?.actionExecutions ?? []).toHaveLength(1);

    const approved = await h.actionService.approveAction((await h.store.load())!, {
      actionId: result.actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
  });

  it("F/deny: process.execute deny creates no Action; task stays working", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "process.execute", "deny");
    await h.store.save(state);

    await expect(
      h.bridge.requestProcessExecution(h.trusted(), {
        executable: "node",
        args: ["-e", "1"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.action_not_authorized" });

    const task = await h.tasks.getTask(h.task.taskId);
    expect(task?.status).toBe("working");
    expect((await h.store.load())?.actionExecutions ?? []).toHaveLength(0);
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("C: request_change_proposal creates existing R3 Action with provenance; deny creates nothing", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "change.propose", "deny");
    await h.store.save(state);
    await expect(
      h.bridge.requestChangeProposal(h.trusted(), { instruction: "Add a comment" })
    ).rejects.toMatchObject({ code: "pairmesh.action_not_authorized" });
    expect((await h.store.load())?.actionExecutions ?? []).toHaveLength(0);

    state = await h.store.load();
    state = grant(state!, "change.propose", "approval_required");
    state = grant(state, "repository.inspect", "allow_session");
    await h.store.save(state);

    const result = await h.bridge.requestChangeProposal(h.trusted(), {
      instruction: "Add a comment to hello.txt"
    });
    expect(result.status).toBe("waiting_for_owner");
    if (result.status !== "waiting_for_owner") {
      return;
    }
    const execution = h.actionService.findExecution((await h.store.load())!, result.actionId);
    expect(execution?.actionType).toBe("change.propose");
    expect(execution?.status).toBe("approval_required");
    expect(execution?.originProvenance).toBe(RECEIVER_AGENT_REQUEST_PROVENANCE);
    expect((await h.tasks.getTask(h.task.taskId))?.status).toBe("blocked_on_action");
  });

  it("D: request_repository_edit is artifact-bound; approve applies exact artifact; stale refused", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "repository.inspect", "allow_session");
    state = grant(state, "change.propose", "allow_session");
    state = grant(state, "repository.source_references", "allow_session");
    state = grant(state, "repository.edit", "approval_required");
    await h.store.save(state);

    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d010");
    const proposal: ProposalArtifactV1 = {
      format: PROPOSAL_FORMAT_V1,
      actionId: proposeId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      createdAt: "2026-09-04T12:00:00.000Z",
      summary: "Change hello",
      affectedPaths: ["src/hello.txt"],
      unifiedDiff: [
        "diff --git a/src/hello.txt b/src/hello.txt",
        "--- a/src/hello.txt",
        "+++ b/src/hello.txt",
        "@@ -1 +1 @@",
        "-hello",
        "+hello world",
        ""
      ].join("\n"),
      stats: { filesChanged: 1, additions: 1, deletions: 1 }
    };
    const created = await h.actionService.createTestArtifact(state, {
      actionId: proposeId,
      bytes: buildCanonicalProposalBytes(proposal),
      artifactType: "patch_diff"
    });
    await h.store.save(created.state);

    const result = await h.bridge.requestRepositoryEdit(h.trusted(), {
      artifactId: created.artifact.artifactId,
      contentHash: created.artifact.contentHash
    });
    expect(result.status).toBe("waiting_for_owner");
    if (result.status !== "waiting_for_owner") {
      return;
    }
    expect(h.actionService.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);

    const approved = await h.actionService.approveAction((await h.store.load())!, {
      actionId: result.actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(await readFile(join(h.workspace, "src", "hello.txt"), "utf8")).toBe("hello world\n");
    expect(h.actionService.repositoryEditExecutor?.applyInvocationCount).toBe(1);

    // Separate task for stale-hash refusal (first task is blocked/completed linkage).
    const h2 = await harness();
    let state2 = await h2.store.load();
    state2 = grant(state2!, "repository.inspect", "allow_session");
    state2 = grant(state2, "change.propose", "allow_session");
    state2 = grant(state2, "repository.source_references", "allow_session");
    state2 = grant(state2, "repository.edit", "approval_required");
    await h2.store.save(state2);
    const propose2 = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d011");
    const created2 = await h2.actionService.createTestArtifact((await h2.store.load())!, {
      actionId: propose2,
      bytes: buildCanonicalProposalBytes({ ...proposal, actionId: propose2 }),
      artifactType: "patch_diff"
    });
    await h2.store.save(created2.state);
    await expect(
      h2.bridge.requestRepositoryEdit(h2.trusted(), {
        artifactId: created2.artifact.artifactId,
        contentHash: "0".repeat(64)
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/artifact|hash|integrity|not_found/i) });
    expect((await h2.store.load())?.actionExecutions ?? []).toHaveLength(0);
  });

  it("E: request_tests_run uses named profile only", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "tests.run", "approval_required");
    await h.store.save(state);

    const result = await h.bridge.requestTestsRun(h.trusted(), { profileName: "unit" });
    expect(result.status).toBe("waiting_for_owner");
    if (result.status !== "waiting_for_owner") {
      return;
    }
    const execution = h.actionService.findExecution((await h.store.load())!, result.actionId);
    expect(execution?.actionType).toBe("tests.run");
    expect(execution?.parameters?.profile).toBe("unit");

    const hDeny = await harness();
    let deniedState = await hDeny.store.load();
    deniedState = grant(deniedState!, "tests.run", "deny");
    await hDeny.store.save(deniedState);
    await expect(
      hDeny.bridge.requestTestsRun(hDeny.trusted(), { profileName: "unit" })
    ).rejects.toMatchObject({ code: "pairmesh.action_not_authorized" });
  });

  it("G: only one blocking Action; conflicting hostToolCallId fails closed", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);

    const callId = mintHostToolCallId();
    await h.bridge.requestProcessExecution(h.trusted(callId), {
      executable: "node",
      args: ["-e", "1"]
    });
    await expect(
      h.bridge.requestProcessExecution(h.trusted(mintHostToolCallId()), {
        executable: "node",
        args: ["-e", "2"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.collaborative_task_already_blocked" });

    await expect(
      h.bridge.requestProcessExecution(h.trusted(callId), {
        executable: "node",
        args: ["-e", "DIFFERENT"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.host_tool_conflict" });
  });

  it("H: revoke after request prevents consequence (existing R4 pre-execute check)", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);

    const result = await h.bridge.requestProcessExecution(h.trusted(), {
      executable: "node",
      args: ["-e", "console.log(1)"]
    });
    if (result.status !== "waiting_for_owner") {
      return;
    }

    let revoked = (await h.store.load())!;
    revoked = grant(revoked, "process.execute", "deny");
    await h.store.save(revoked);

    await expect(
      h.actionService.approveAction((await h.store.load())!, {
        actionId: result.actionId,
        decision: "allow-once"
      })
    ).rejects.toMatchObject({ code: "pairmesh.action_not_authorized" });
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
    expect((await h.tasks.getTask(h.task.taskId))?.status).toBe("blocked_on_action");
  });

  it("I: host idempotency survives store reload", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);
    const callId = mintHostToolCallId();
    const first = await h.bridge.requestProcessExecution(h.trusted(callId), {
      executable: "node",
      args: ["-e", "console.log(1)"]
    });
    const bridge2 = new HostRequestBridge({
      stateStore: new LocalStateStore({ stateFilePath: h.stateFilePath }),
      actionService: h.actionService
    });
    const second = await bridge2.requestProcessExecution(h.trusted(callId), {
      executable: "node",
      args: ["-e", "console.log(1)"]
    });
    expect(second).toEqual(first);
  });

  it("J: shell host executable rejected by R4; requester cannot use receiver host tools", async () => {
    const h = await harness();
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    // Flip local identity to Paul (requester) — host tools must refuse.
    state = {
      ...state,
      localParticipant: {
        ...state.localParticipant,
        participant: { ...state.localParticipant.participant, id: paulId }
      }
    };
    await h.store.save(state);
    await expect(
      h.bridge.requestProcessExecution(h.trusted(), {
        executable: "node",
        args: ["-e", "1"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.host_tool_not_allowed" });

    const h2 = await harness();
    let state2 = await h2.store.load();
    state2 = grant(state2!, "process.execute", "approval_required");
    await h2.store.save(state2);
    await expect(
      h2.bridge.requestProcessExecution(h2.trusted(), {
        executable: "bash",
        args: ["-c", "echo hi"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.process_executable_invalid" });
  });
});
