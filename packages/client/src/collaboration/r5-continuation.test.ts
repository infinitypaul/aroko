import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAIRMESH_GRANTABLE_CAPABILITIES,
  PeerIdSchema,
  SessionIdSchema,
  mintActionObservationKey
} from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import type { PairMeshProcessExecutionConfig } from "../local-config/schema.js";
import { ActionService } from "../action/service.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { CodingAgentProposalGenerator } from "../action/proposal/index.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { LocalStateStore } from "../state/store.js";
import { CollaborativeTaskService } from "./collaborative-task-service.js";
import { InputRequestService } from "./input-request-service.js";
import { HostRequestBridge } from "./host-request-service.js";
import { ContinuationOrchestrator } from "./continuation-orchestrator.js";
import { FakeTaskWorker } from "./fake-task-worker.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

function baseState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-R55CNT",
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
    hostToolCalls: [],
    providerTurns: [],
    continuationEvents: []
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

async function harness(worker?: FakeTaskWorker) {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r5-5-ws-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "hello.txt"), "hello\n", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-r5-5-state-"));
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
  const fake = worker ?? new FakeTaskWorker({ instanceId: "A" });
  const orchestrator = new ContinuationOrchestrator({
    stateStore: store,
    actionService,
    hostBridge: bridge,
    worker: fake,
    providerSessionRef: null
  });
  const task = await tasks.createTask({
    sessionId,
    requesterParticipantId: paulId,
    ownerParticipantId: kelvinId,
    originalGoal: "Prepare this project for package X"
  });
  return {
    store,
    actionService,
    tasks,
    inputs,
    bridge,
    orchestrator,
    fake,
    task,
    workspace,
    stateFilePath,
    setProcessConfig: (next: PairMeshProcessExecutionConfig) => {
      processConfig = next;
    }
  };
}

describe("R5-5 continuation orchestrator", () => {
  it("A: ProviderTurn lifecycle via startTaskTurn completing", async () => {
    const worker = new FakeTaskWorker({
      instanceId: "A",
      script: [{ kind: "completed", summary: "Goal finished without tools." }]
    });
    const h = await harness(worker);
    const result = await h.orchestrator.startTaskTurn(h.task.taskId);
    expect(result.turnResult.kind).toBe("completed");
    expect(result.taskStatus).toBe("completed");

    const turns = await h.orchestrator.listProviderTurns(h.task.taskId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("completed");
    expect(turns[0]?.providerTurnId).toMatch(/^pturn_/);
    expect(turns[0]?.endedAt).toBeTruthy();

    const task = await h.tasks.getTask(h.task.taskId);
    expect(task?.activeProviderTurnId).toBeUndefined();
    expect(task?.childRefs.filter((r) => r.kind === "provider_turn")).toHaveLength(1);
    expect(task?.result?.summary).toContain("Goal finished");
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toHaveLength(6);
  });

  it("B: Input continuation — answer → new Fake instance continueTask sees answer + seq 1", async () => {
    const turn1 = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => ({
        kind: "host_request",
        toolName: "request_requester_input",
        args: {
          question: "Initialize project?",
          options: ["Yes", "No"]
        },
        checkpointSummary: "Asked whether to initialize."
      })
    });
    const h = await harness(turn1);
    const first = await h.orchestrator.startTaskTurn(h.task.taskId);
    expect(first.turnResult.kind).toBe("host_request");
    expect(first.taskStatus).toBe("waiting_for_input");

    const waiting = await h.tasks.getTask(h.task.taskId);
    expect(waiting?.pendingInputRequestId).toBeTruthy();
    expect(waiting?.activeProviderTurnId).toBeUndefined();

    const answered = await h.inputs.answerInputRequest({
      taskId: h.task.taskId,
      inputRequestId: waiting!.pendingInputRequestId!,
      answer: "Yes",
      answeringParticipantId: paulId
    });
    expect(answered.task.status).toBe("working");
    expect(answered.task.continuationSeq).toBe(1);

    const events = await h.orchestrator.listContinuationEvents(h.task.taskId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("REQUESTER_INPUT_RECEIVED");
    expect(events[0]?.continuationSeq).toBe(1);
    expect(events[0]?.structuredResult?.answer).toBe("Yes");

    const turn2 = new FakeTaskWorker({
      instanceId: "B",
      onTurn: async (envelope) => {
        expect(envelope.kind).toBe("continuation");
        expect(envelope.taskId).toBe(h.task.taskId);
        expect(envelope.continuationSeq).toBe(1);
        if (envelope.kind === "continuation") {
          expect(envelope.event.type).toBe("REQUESTER_INPUT_RECEIVED");
          expect(envelope.event.structuredResult?.answer).toBe("Yes");
          expect(envelope.previousCheckpoint).toContain("initialize");
        }
        expect(JSON.stringify(envelope)).not.toMatch(/providerSessionRef|bearer|controlToken/i);
        return { kind: "completed", summary: `Continued by ${turn2.instanceId}` };
      }
    });
    h.orchestrator.setWorker(turn2);
    const second = await h.orchestrator.continueTask(h.task.taskId);
    expect(second.taskStatus).toBe("completed");
    expect(turn2.envelopesReceived).toHaveLength(1);
    expect(turn2.instanceId).toBe("B");
    expect(turn1.envelopesReceived).toHaveLength(1);
  });

  it("C: process success — grant → approve → observe → continue; spawn stays 1", async () => {
    const turn1 = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => ({
        kind: "host_request",
        toolName: "request_process_execution",
        args: { executable: "node", args: ["-e", "console.log('R5_5_OK')"] },
        checkpointSummary: "Requested node process."
      })
    });
    const h = await harness(turn1);
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);

    const first = await h.orchestrator.startTaskTurn(h.task.taskId);
    expect(first.taskStatus).toBe("blocked_on_action");
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);

    const blocked = await h.tasks.getTask(h.task.taskId);
    const actionId = blocked!.blockedOnActionId!;
    const approved = await h.actionService.approveAction((await h.store.load())!, {
      actionId,
      decision: "allow-once"
    });
    await h.store.save(approved.state);
    expect(approved.execution.status).toBe("completed");
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount).toBe(1);

    const continuation = await h.orchestrator.observeActionTerminal(approved.execution);
    expect(continuation?.type).toBe("ACTION_COMPLETED");
    expect((await h.tasks.getTask(h.task.taskId))?.status).toBe("working");
    expect((await h.tasks.getTask(h.task.taskId))?.continuationSeq).toBe(1);

    // Idempotent re-observe
    const again = await h.orchestrator.observeActionTerminal(approved.execution);
    expect(again?.eventId).toBe(continuation?.eventId);
    expect((await h.tasks.getTask(h.task.taskId))?.continuationSeq).toBe(1);

    const turn2 = new FakeTaskWorker({
      instanceId: "B",
      onTurn: async (envelope) => {
        expect(envelope.kind).toBe("continuation");
        if (envelope.kind === "continuation") {
          expect(envelope.event.type).toBe("ACTION_COMPLETED");
          expect(envelope.event.structuredResult?.actionId).toBe(actionId);
          expect(String(envelope.event.structuredResult?.stdoutSafe ?? "")).toContain("R5_5_OK");
        }
        return { kind: "completed", summary: "Process succeeded; done." };
      }
    });
    h.orchestrator.setWorker(turn2);
    const second = await h.orchestrator.continueTask(h.task.taskId);
    expect(second.taskStatus).toBe("completed");
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
  });

  it("D: deny → ACTION_DENIED continuation", async () => {
    const turn1 = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => ({
        kind: "host_request",
        toolName: "request_process_execution",
        args: { executable: "node", args: ["-e", "1"] },
        checkpointSummary: "Requested process."
      })
    });
    const h = await harness(turn1);
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);

    await h.orchestrator.startTaskTurn(h.task.taskId);
    const actionId = (await h.tasks.getTask(h.task.taskId))!.blockedOnActionId!;
    const denied = await h.actionService.approveAction((await h.store.load())!, {
      actionId,
      decision: "deny"
    });
    await h.store.save(denied.state);
    expect(denied.execution.status).toBe("denied");
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);

    const event = await h.orchestrator.observeActionTerminal(denied.execution);
    expect(event?.type).toBe("ACTION_DENIED");

    const turn2 = new FakeTaskWorker({
      instanceId: "B",
      onTurn: async (envelope) => {
        expect(envelope.kind).toBe("continuation");
        if (envelope.kind === "continuation") {
          expect(envelope.event.type).toBe("ACTION_DENIED");
        }
        return { kind: "completed", summary: "Cannot proceed after deny." };
      }
    });
    h.orchestrator.setWorker(turn2);
    const second = await h.orchestrator.continueTask(h.task.taskId);
    expect(second.taskStatus).toBe("completed");
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("E: unknown_outcome — observe + continue; no second spawn", async () => {
    const turn1 = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => ({
        kind: "host_request",
        toolName: "request_process_execution",
        args: { executable: "node", args: ["-e", "console.log('x')"] },
        checkpointSummary: "Requested process."
      })
    });
    const h = await harness(turn1);
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);

    await h.orchestrator.startTaskTurn(h.task.taskId);
    const actionId = (await h.tasks.getTask(h.task.taskId))!.blockedOnActionId!;
    const execution = h.actionService.findExecution((await h.store.load())!, actionId)!;
    expect(execution.status).toBe("approval_required");

    // Manually mark unknown_outcome (R4 uncertainty fixture) without spawning.
    await h.store.mutate((s) => {
      const idx = (s.actionExecutions ?? []).findIndex((e) => e.actionId === actionId);
      s.actionExecutions![idx] = {
        ...s.actionExecutions![idx]!,
        status: "unknown_outcome",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        result: {
          actionId,
          status: "unknown_outcome",
          summary: "Outcome uncertain after interrupt.",
          unknownOutcome: true,
          executorInvocationCount: 1
        }
      };
    });

    const unknown = h.actionService.findExecution((await h.store.load())!, actionId)!;
    const event = await h.orchestrator.observeActionTerminal(unknown);
    expect(event?.type).toBe("ACTION_UNKNOWN_OUTCOME");
    expect(event?.structuredResult?.unknownOutcome).toBe(true);

    const turn2 = new FakeTaskWorker({
      instanceId: "B",
      onTurn: async (envelope) => {
        if (envelope.kind === "continuation") {
          expect(envelope.event.type).toBe("ACTION_UNKNOWN_OUTCOME");
        }
        return { kind: "completed", summary: "Reported uncertainty; no retry." };
      }
    });
    h.orchestrator.setWorker(turn2);
    await h.orchestrator.continueTask(h.task.taskId);
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
    expect((await h.store.load())?.actionExecutions ?? []).toHaveLength(1);
  });

  it("F: crash after input event before turn — continue once; second fails consumed", async () => {
    const turn1 = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => ({
        kind: "host_request",
        toolName: "request_requester_input",
        args: { question: "Continue?", options: ["Yes"] },
        checkpointSummary: "Asked continue."
      })
    });
    const h = await harness(turn1);
    await h.orchestrator.startTaskTurn(h.task.taskId);
    const pendingId = (await h.tasks.getTask(h.task.taskId))!.pendingInputRequestId!;
    await h.inputs.answerInputRequest({
      taskId: h.task.taskId,
      inputRequestId: pendingId,
      answer: "Yes",
      answeringParticipantId: paulId
    });

    // Simulate restart: new store + orchestrator on same state file.
    const store2 = new LocalStateStore({ stateFilePath: h.stateFilePath });
    const actionService2 = new ActionService({
      stateFilePath: h.stateFilePath,
      workspaceRoot: h.workspace,
      proposalGenerator: new CodingAgentProposalGenerator(new FakeCodingAgentAdapter(h.workspace)),
      loadProcessConfig: () => ({
        maxConcurrent: 1,
        defaultTimeoutMs: 15_000,
        maxTimeoutMs: 60_000,
        maxOutputBytes: 8_192,
        env: {}
      })
    });
    const bridge2 = new HostRequestBridge({ stateStore: store2, actionService: actionService2 });
    const turn2 = new FakeTaskWorker({
      instanceId: "restarted",
      onTurn: async (envelope) => {
        expect(envelope.continuationSeq).toBe(1);
        // Cancelled clears active turn only — task stays working so consumption fencing is testable.
        return { kind: "cancelled" };
      }
    });
    const orch2 = new ContinuationOrchestrator({
      stateStore: store2,
      actionService: actionService2,
      hostBridge: bridge2,
      worker: turn2,
      providerSessionRef: null
    });

    const events = await orch2.listContinuationEvents(h.task.taskId);
    expect(events).toHaveLength(1);
    expect(events[0]?.consumedByProviderTurnId).toBeUndefined();

    const once = await orch2.continueTask(h.task.taskId);
    expect(once.turnResult.kind).toBe("cancelled");
    expect(once.taskStatus).toBe("working");
    expect(turn2.envelopesReceived).toHaveLength(1);

    const after = await orch2.listContinuationEvents(h.task.taskId);
    expect(after[0]?.consumedByProviderTurnId).toBe(once.providerTurnId);

    await expect(orch2.continueTask(h.task.taskId)).rejects.toMatchObject({
      code: "pairmesh.provider_turn_not_allowed"
    });

    await expect(orch2.continueTask(h.task.taskId, events[0]!.eventId)).rejects.toMatchObject({
      code: "pairmesh.continuation_already_consumed"
    });
  });

  it("G: host checkpoint ends turn; worker returns only one host request", async () => {
    let calls = 0;
    const worker = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => {
        calls += 1;
        return {
          kind: "host_request",
          toolName: "request_requester_input",
          args: { question: `Q${calls}` },
          checkpointSummary: `checkpoint-${calls}`
        };
      }
    });
    const h = await harness(worker);
    const result = await h.orchestrator.startTaskTurn(h.task.taskId);
    expect(result.turnResult.kind).toBe("host_request");
    expect(calls).toBe(1);

    const turns = await h.orchestrator.listProviderTurns(h.task.taskId);
    expect(turns[0]?.status).toBe("completed");
    expect(turns[0]?.toolRequest?.name).toBe("request_requester_input");
    expect(turns[0]?.toolRequest?.argsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(turns[0]?.checkpointSummary).toBe("checkpoint-1");
    expect((await h.tasks.getTask(h.task.taskId))?.status).toBe("waiting_for_input");
    expect((await h.store.load())?.inputRequests ?? []).toHaveLength(1);
  });

  it("H: providerSessionRef null works across turns", async () => {
    const turn1 = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => ({
        kind: "host_request",
        toolName: "request_requester_input",
        args: { question: "Ready?" },
        checkpointSummary: "Asked ready."
      })
    });
    const h = await harness(turn1);
    await h.orchestrator.startTaskTurn(h.task.taskId);
    const turns1 = await h.orchestrator.listProviderTurns(h.task.taskId);
    expect(turns1[0]?.providerSessionRef).toBeUndefined();

    const pendingId = (await h.tasks.getTask(h.task.taskId))!.pendingInputRequestId!;
    await h.inputs.answerInputRequest({
      taskId: h.task.taskId,
      inputRequestId: pendingId,
      answer: "Yes",
      answeringParticipantId: paulId
    });

    const turn2 = new FakeTaskWorker({
      instanceId: "B",
      onTurn: async () => ({ kind: "completed", summary: "Done without provider session." })
    });
    h.orchestrator.setWorker(turn2);
    await h.orchestrator.continueTask(h.task.taskId);
    const turns2 = await h.orchestrator.listProviderTurns(h.task.taskId);
    expect(turns2.every((t) => t.providerSessionRef === undefined)).toBe(true);
    expect(JSON.stringify(turn2.envelopesReceived[0])).not.toContain("providerSessionRef");
  });

  it("I: conflicting action observation fail closed", async () => {
    const turn1 = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => ({
        kind: "host_request",
        toolName: "request_process_execution",
        args: { executable: "node", args: ["-e", "1"] },
        checkpointSummary: "Requested process."
      })
    });
    const h = await harness(turn1);
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);

    await h.orchestrator.startTaskTurn(h.task.taskId);
    const actionId = (await h.tasks.getTask(h.task.taskId))!.blockedOnActionId!;
    const denied = await h.actionService.approveAction((await h.store.load())!, {
      actionId,
      decision: "deny"
    });
    await h.store.save(denied.state);

    const first = await h.orchestrator.observeActionTerminal(denied.execution);
    expect(first?.type).toBe("ACTION_DENIED");
    expect(first?.observationKey).toBe(mintActionObservationKey(actionId, "denied"));

    // Conflict: same actionId observed as a different terminal type.
    await expect(
      h.orchestrator.observeActionTerminal({
        ...denied.execution,
        status: "completed",
        result: {
          actionId,
          status: "completed",
          summary: "spoofed"
        }
      })
    ).rejects.toMatchObject({ code: "pairmesh.continuation_event_conflict" });
  });

  it("J: crash after Action event before turn — reload continues once; no Action replay", async () => {
    const turn1 = new FakeTaskWorker({
      instanceId: "A",
      onTurn: async () => ({
        kind: "host_request",
        toolName: "request_process_execution",
        args: { executable: "node", args: ["-e", "console.log('once')"] },
        checkpointSummary: "Requested process."
      })
    });
    const h = await harness(turn1);
    let state = await h.store.load();
    state = grant(state!, "process.execute", "approval_required");
    await h.store.save(state);

    await h.orchestrator.startTaskTurn(h.task.taskId);
    const actionId = (await h.tasks.getTask(h.task.taskId))!.blockedOnActionId!;
    const approved = await h.actionService.approveAction((await h.store.load())!, {
      actionId,
      decision: "allow-once"
    });
    await h.store.save(approved.state);
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
    await h.orchestrator.observeActionTerminal(approved.execution);

    const store2 = new LocalStateStore({ stateFilePath: h.stateFilePath });
    const actionService2 = new ActionService({
      stateFilePath: h.stateFilePath,
      workspaceRoot: h.workspace,
      loadProcessConfig: () => ({
        maxConcurrent: 1,
        defaultTimeoutMs: 15_000,
        maxTimeoutMs: 60_000,
        maxOutputBytes: 8_192,
        env: {}
      })
    });
    const bridge2 = new HostRequestBridge({ stateStore: store2, actionService: actionService2 });
    const turn2 = new FakeTaskWorker({
      instanceId: "B",
      onTurn: async (envelope) => {
        expect(envelope.kind).toBe("continuation");
        if (envelope.kind === "continuation") {
          expect(envelope.event.type).toBe("ACTION_COMPLETED");
        }
        return { kind: "completed", summary: "Resumed after Action event crash boundary." };
      }
    });
    const orch2 = new ContinuationOrchestrator({
      stateStore: store2,
      actionService: actionService2,
      hostBridge: bridge2,
      worker: turn2
    });

    await orch2.recoverAfterRestart();
    const resumed = await orch2.continueTask(h.task.taskId);
    expect(resumed.taskStatus).toBe("completed");
    expect(h.actionService.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
    expect(actionService2.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("K: recoverAfterRestart — active turn with no child emits one TASK_RESUMED_AFTER_RESTART", async () => {
    const h = await harness(
      new FakeTaskWorker({
        instanceId: "A",
        onTurn: async () => ({ kind: "completed", summary: "unused" })
      })
    );
    // Manually plant a stuck running turn without a durable child.
    await h.store.mutate((state) => {
      const task = state.collaborativeTasks![0]!;
      const turnId = `pturn_018f7b8a-4f31-7cc5-9a7c-fd3394f4af99`;
      state.providerTurns = [
        {
          providerTurnId: turnId as never,
          taskId: task.taskId,
          status: "running",
          startedAt: "2026-09-04T12:00:00.000Z"
        }
      ];
      state.collaborativeTasks![0] = {
        ...task,
        activeProviderTurnId: turnId as never,
        updatedAt: "2026-09-04T12:00:00.000Z"
      };
    });

    await h.orchestrator.recoverAfterRestart();
    const events = await h.orchestrator.listContinuationEvents(h.task.taskId);
    expect(events.some((e) => e.type === "TASK_RESUMED_AFTER_RESTART")).toBe(true);
    expect((await h.tasks.getTask(h.task.taskId))?.activeProviderTurnId).toBeUndefined();
    const turns = await h.orchestrator.listProviderTurns(h.task.taskId);
    expect(turns[0]?.status).toBe("failed");

    await h.orchestrator.recoverAfterRestart();
    const again = await h.orchestrator.listContinuationEvents(h.task.taskId);
    expect(again.filter((e) => e.type === "TASK_RESUMED_AFTER_RESTART")).toHaveLength(1);
  });
});
