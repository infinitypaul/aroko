/**
 * R5-7 — CollaborativeTask progress / history / provenance unit matrix.
 * Fixtures only — no live providers.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  CollaborativeTaskIdSchema,
  InputRequestIdSchema,
  PeerIdSchema,
  ProviderTurnIdSchema,
  RECEIVER_AGENT_REQUEST_PROVENANCE,
  SessionIdSchema,
  type ActionExecutionRecord,
  type CollaborativeTask,
  type InputRequest,
  type ProviderTurn
} from "@pairmesh/protocol";
import { createSessionSecurity } from "../auth/session-security.js";
import { toActionSafeView } from "../action/session-bridge.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import {
  buildCollaborativeTaskTimeline,
  formatReceiverAgentActionProvenance,
  projectCollaborativeTaskHistory,
  projectCollaborativeTaskProgress,
  summarizeGoal,
  type DeriveTaskProgressInput,
  type SafeParticipantLabel
} from "./task-progress-present.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");
const taskId = CollaborativeTaskIdSchema.parse("task_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const inputId = InputRequestIdSchema.parse("inq_018f7b8a-4f31-7cc5-9a7c-fd3394f4af11");
const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4af21");
const turnId = ProviderTurnIdSchema.parse("pturn_018f7b8a-4f31-7cc5-9a7c-fd3394f4af31");

const T0 = "2026-09-10T12:00:00.000Z";
const T1 = "2026-09-10T12:01:00.000Z";
const T2 = "2026-09-10T12:02:00.000Z";
const T3 = "2026-09-10T12:03:00.000Z";

const paul: SafeParticipantLabel = { participantId: paulId, displayName: "Paul" };
const kelvin: SafeParticipantLabel = { participantId: kelvinId, displayName: "Kelvin" };

const EVIDENCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/validation/r5-7-ux-evidence"
);

function baseTask(overrides: Partial<CollaborativeTask> = {}): CollaborativeTask {
  return {
    taskId,
    sessionId,
    requesterParticipantId: paulId,
    ownerParticipantId: kelvinId,
    originalGoal: "Help initialize the project and install is-odd.",
    status: "working",
    childRefs: [],
    continuationSeq: 0,
    appliedEvents: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
}

function baseInput(overrides: Partial<InputRequest> = {}): InputRequest {
  return {
    inputRequestId: inputId,
    taskId,
    requestedFrom: "requester",
    question: "Should I initialize the project?",
    options: ["Yes", "No"],
    allowFreeText: true,
    status: "pending",
    createdAt: T1,
    ...overrides
  };
}

function baseAction(overrides: Partial<ActionExecutionRecord> = {}): ActionExecutionRecord {
  return {
    actionId,
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    actionType: "process.execute",
    capabilityId: "process.execute",
    status: "approval_required",
    parameters: {
      executable: "node",
      args: ["-e", "console.log('ok')"],
      cwd: ".",
      timeoutMs: 15_000,
      maxOutputBytes: 8_192
    },
    parameterDigest: "a".repeat(64),
    mutability: "mutation",
    createdAt: T1,
    updatedAt: T1,
    executorInvocationCount: 0,
    taskId,
    originProvenance: RECEIVER_AGENT_REQUEST_PROVENANCE,
    originProviderTurnId: turnId,
    ...overrides
  };
}

function baseTurn(overrides: Partial<ProviderTurn> = {}): ProviderTurn {
  return {
    providerTurnId: turnId,
    taskId,
    status: "running",
    startedAt: T0,
    ...overrides
  };
}

function progressInput(
  partial: Partial<DeriveTaskProgressInput> & Pick<DeriveTaskProgressInput, "task">
): DeriveTaskProgressInput {
  return {
    viewerRole: "owner",
    requester: paul,
    owner: kelvin,
    providerDisplayName: "Fake",
    ...partial
  };
}

function baseState(localId = kelvinId): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-R57PRG",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: T0,
      status: "active"
    },
    localParticipant: {
      participant: {
        id: localId,
        sessionId,
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: T0
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
        displayName: localId === kelvinId ? "Kelvin" : "Paul"
      },
      a2aAgentUrl: "http://127.0.0.1:4502/",
      isLocal: true
    },
    peers: [
      {
        participant: {
          id: localId === kelvinId ? paulId : kelvinId,
          sessionId,
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          joinedAt: T0
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
          displayName: localId === kelvinId ? "Paul" : "Kelvin"
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

describe("R5-7 phase / waitingOn", () => {
  it("1. working → working_on_request, waitingOn provider", () => {
    const projection = projectCollaborativeTaskProgress(
      progressInput({
        task: baseTask({ status: "working", activeProviderTurnId: turnId }),
        providerTurns: [baseTurn()]
      })
    );
    expect(projection).toMatchObject({
      phase: "working_on_request",
      waitingOn: "provider",
      phaseLabel: "Working on request"
    });
  });

  it("2. waiting_for_input → needs_requester_input, waitingOn requester", () => {
    const projection = projectCollaborativeTaskProgress(
      progressInput({
        task: baseTask({
          status: "waiting_for_input",
          pendingInputRequestId: inputId,
          updatedAt: T1
        }),
        inputRequests: [baseInput()]
      })
    );
    expect(projection).toMatchObject({
      phase: "needs_requester_input",
      waitingOn: "requester",
      phaseLabel: "Waiting for requester"
    });
  });

  it("3. blocked_on_action + approval_required → waiting_for_owner_action, waitingOn owner", () => {
    const projection = projectCollaborativeTaskProgress(
      progressInput({
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: [baseAction({ status: "approval_required" })]
      })
    );
    expect(projection).toMatchObject({
      phase: "waiting_for_owner_action",
      waitingOn: "owner",
      phaseLabel: "Waiting for owner"
    });
  });

  it("4. blocked_on_action + executing → running_approved_work", () => {
    const projection = projectCollaborativeTaskProgress(
      progressInput({
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: [baseAction({ status: "executing" })]
      })
    );
    expect(projection).toMatchObject({
      phase: "running_approved_work",
      waitingOn: "provider",
      phaseLabel: "Running approved work"
    });
  });

  it("4b. R5-8-D3: blocked_on_action + completed Action must not claim Waiting for owner", () => {
    const projection = projectCollaborativeTaskProgress(
      progressInput({
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: [baseAction({ status: "completed" })]
      })
    );
    expect(projection.phase).not.toBe("waiting_for_owner_action");
    expect(projection.waitingOn).not.toBe("owner");
    expect(projection.phaseLabel).not.toBe("Waiting for owner");
  });

  it("4c. R5-8-D3: blocked_on_action + missing Action must not claim Waiting for owner", () => {
    const projection = projectCollaborativeTaskProgress(
      progressInput({
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: []
      })
    );
    expect(projection.phase).not.toBe("waiting_for_owner_action");
    expect(projection.waitingOn).not.toBe("owner");
  });

  it("5. continuationSeq>0 working → continuing_work", () => {
    const projection = projectCollaborativeTaskProgress(
      progressInput({
        task: baseTask({
          status: "working",
          continuationSeq: 2,
          activeProviderTurnId: turnId
        })
      })
    );
    expect(projection).toMatchObject({
      phase: "continuing_work",
      waitingOn: "provider",
      phaseLabel: "Continuing work"
    });
  });

  it("6. completed / failed / cancelled → matching phase, waitingOn none", () => {
    for (const [status, phase] of [
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"]
    ] as const) {
      const projection = projectCollaborativeTaskProgress(
        progressInput({
          task: baseTask({
            status,
            completedAt: T3,
            ...(status === "completed"
              ? { result: { summary: "Done." } }
              : status === "failed"
                ? { failure: { code: "pairmesh.task_failed", message: "Boom" } }
                : {})
          })
        })
      );
      expect(projection).toMatchObject({
        phase,
        waitingOn: "none",
        terminal: true
      });
    }
  });

  it("7. no false owner wait when action not approval_required", () => {
    const requesterView = projectCollaborativeTaskProgress(
      progressInput({
        viewerRole: "requester",
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: [baseAction({ status: "executing" })]
      })
    );
    expect(requesterView.waitingOn).toBe("provider");
    expect(requesterView.ownerWaitSummary).toBeUndefined();
    expect(requesterView.phase).toBe("running_approved_work");
  });
});

describe("R5-7 provenance", () => {
  it("8. formatReceiverAgentActionProvenance with Paul name → agent-while-working framing", () => {
    const label = formatReceiverAgentActionProvenance({
      originProvenance: RECEIVER_AGENT_REQUEST_PROVENANCE,
      requesterDisplayName: "Paul"
    });
    expect(label).toBe("Requested by your agent while working on Paul's task.");
  });

  it('9. MUST NOT equal / contain "Paul requested" as the command requester framing', () => {
    const label = formatReceiverAgentActionProvenance({
      originProvenance: RECEIVER_AGENT_REQUEST_PROVENANCE,
      requesterDisplayName: "Paul"
    });
    expect(label).not.toMatch(/Paul requested/i);
    expect(label).not.toBe("Paul requested this command.");
  });

  it("10. missing name → collaborative task fallback string", () => {
    expect(
      formatReceiverAgentActionProvenance({
        originProvenance: RECEIVER_AGENT_REQUEST_PROVENANCE
      })
    ).toBe("Requested by your agent while working on a collaborative task.");
  });
});

describe("R5-7 privacy strip", () => {
  it("11. malicious goal/question/answer/checkpoint do not leak secret fields; goal bounded", () => {
    const longGoal =
      `<script>alert(1)</script> controlToken=ctl_secret_abc bearerToken=Bearer xyz ` +
      `providerSessionRef=sess_leak ` +
      "x".repeat(400);
    const task = baseTask({
      originalGoal: longGoal,
      status: "waiting_for_input",
      pendingInputRequestId: inputId,
      result: { summary: "ok" }
    });
    const input = baseInput({
      question: `<script>q</script> controlToken=inq_tok bearer=tok`,
      answer: undefined
    });
    const turn = baseTurn({
      status: "completed",
      endedAt: T2,
      providerSessionRef: "secret-provider-session-ref-DO-NOT-LEAK",
      checkpointSummary: "Safe checkpoint only — no session handle."
    });
    const progress = projectCollaborativeTaskProgress(
      progressInput({
        task,
        inputRequests: [input],
        providerTurns: [turn]
      })
    );
    const history = projectCollaborativeTaskHistory(
      progressInput({
        task: { ...task, status: "completed", completedAt: T3, pendingInputRequestId: undefined },
        inputRequests: [
          {
            ...input,
            status: "answered",
            answeredAt: T2,
            answer: `<script>a</script> bearerToken=answer_secret`
          }
        ],
        providerTurns: [turn]
      })
    );

    expect(progress.originalGoal).toBe(longGoal);
    expect(progress.goalSummary.length).toBeLessThanOrEqual(240);
    expect(
      progress.goalSummary.endsWith("…") || progress.goalSummary.length < longGoal.length
    ).toBe(true);
    expect(summarizeGoal(longGoal).length).toBeLessThanOrEqual(240);

    const progressBlob = JSON.stringify(progress);
    const historyBlob = JSON.stringify(history);
    expect(progressBlob).not.toContain("secret-provider-session-ref-DO-NOT-LEAK");
    expect(historyBlob).not.toContain("secret-provider-session-ref-DO-NOT-LEAK");
    expect(progress).not.toHaveProperty("controlToken");
    expect(progress).not.toHaveProperty("bearerToken");
    expect(progress).not.toHaveProperty("providerSessionRef");
    expect(history).not.toHaveProperty("controlToken");
    expect(history).not.toHaveProperty("bearerToken");
    expect(history).not.toHaveProperty("providerSessionRef");

    for (const row of history.timeline) {
      expect(row.label).not.toMatch(/<\/?(html|div|script)\b/i);
      if (row.detail) {
        expect(row.detail).not.toMatch(/<\/?(html|div)\b/i);
      }
    }
  });
});

describe("R5-7 timeline dedupe + outcomes", () => {
  it("12. building timeline twice with same InputRequest/Action IDs yields one row per eventKey", () => {
    const input = progressInput({
      task: baseTask({
        status: "completed",
        completedAt: T3,
        result: { summary: "Finished." }
      }),
      inputRequests: [
        baseInput({
          status: "answered",
          answeredAt: T2,
          answer: "Yes"
        })
      ],
      actions: [
        baseAction({
          status: "completed",
          completedAt: T2,
          updatedAt: T2,
          approvedAt: T1
        })
      ]
    });
    const a = buildCollaborativeTaskTimeline(input);
    const b = buildCollaborativeTaskTimeline(input);
    const keysA = a.map((row) => row.eventKey);
    const keysB = b.map((row) => row.eventKey);
    expect(new Set(keysA).size).toBe(keysA.length);
    expect(keysA).toEqual(keysB);
    expect(keysA.filter((k) => k === `input_request:${inputId}`)).toHaveLength(1);
    expect(keysA.filter((k) => k === `action_request:${actionId}`)).toHaveLength(1);
  });

  it('13. unknown_outcome → "Execution outcome is uncertain."', () => {
    const timeline = buildCollaborativeTaskTimeline(
      progressInput({
        task: baseTask({ status: "failed", completedAt: T3 }),
        actions: [
          baseAction({
            status: "unknown_outcome",
            completedAt: T2,
            updatedAt: T2
          })
        ]
      })
    );
    const terminal = timeline.find((row) => row.kind === "action_terminal");
    expect(terminal?.label).toBe("Execution outcome is uncertain.");
  });

  it('14. denial → denied language, not "completed" execution success', () => {
    const timeline = buildCollaborativeTaskTimeline(
      progressInput({
        task: baseTask({ status: "failed", completedAt: T3 }),
        actions: [
          baseAction({
            status: "denied",
            completedAt: T2,
            updatedAt: T2
          })
        ]
      })
    );
    const decision = timeline.find((row) => row.kind === "action_decision");
    const terminal = timeline.find((row) => row.kind === "action_terminal");
    expect(decision?.label.toLowerCase()).toContain("denied");
    expect(terminal?.label.toLowerCase()).toContain("denied");
    expect(terminal?.label.toLowerCase()).not.toContain("completed");
  });
});

describe("R5-7 Input vs Approve semantics", () => {
  it('15. pendingInput.interaction === "answer"', () => {
    const projection = projectCollaborativeTaskProgress(
      progressInput({
        viewerRole: "requester",
        task: baseTask({
          status: "waiting_for_input",
          pendingInputRequestId: inputId
        }),
        inputRequests: [baseInput()]
      })
    );
    expect(projection.pendingInput).toMatchObject({
      inputRequestId: inputId,
      interaction: "answer"
    });
  });

  it("16. pendingAction present only for owner viewer with approval_required", () => {
    const owner = projectCollaborativeTaskProgress(
      progressInput({
        viewerRole: "owner",
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: [baseAction({ status: "approval_required" })]
      })
    );
    const requester = projectCollaborativeTaskProgress(
      progressInput({
        viewerRole: "requester",
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: [baseAction({ status: "approval_required" })]
      })
    );
    const ownerExecuting = projectCollaborativeTaskProgress(
      progressInput({
        viewerRole: "owner",
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: [baseAction({ status: "executing" })]
      })
    );
    expect(owner.pendingAction).toMatchObject({
      actionId,
      actionType: "process.execute"
    });
    expect(owner.pendingAction?.provenanceLabel).toContain("Paul's task");
    expect(requester.pendingAction).toBeUndefined();
    expect(requester.ownerWaitSummary).toMatch(/Waiting for Kelvin to approve/);
    expect(ownerExecuting.pendingAction).toBeUndefined();
  });
});

describe("R5-7 ActionSafeView provenance passthrough", () => {
  it("17. toActionSafeView includes taskId + originProvenance from execution fixture", () => {
    const state = baseState(kelvinId);
    const execution = baseAction({
      taskId,
      originProvenance: RECEIVER_AGENT_REQUEST_PROVENANCE,
      originProviderTurnId: turnId
    });
    const view = toActionSafeView(state, execution);
    expect(view.taskId).toBe(taskId);
    expect(view.originProvenance).toBe(RECEIVER_AGENT_REQUEST_PROVENANCE);
    expect(view.originProviderTurnId).toBe(turnId);
  });
});

describe("R5-7 UX evidence fixtures", () => {
  it("writes deterministic projected evidence JSON under docs/validation/r5-7-ux-evidence/", async () => {
    const liveWorking = projectCollaborativeTaskProgress(
      progressInput({
        task: baseTask({ status: "working", activeProviderTurnId: turnId }),
        providerTurns: [baseTurn()]
      })
    );
    const liveWaitingRequester = projectCollaborativeTaskProgress(
      progressInput({
        viewerRole: "requester",
        task: baseTask({
          status: "waiting_for_input",
          pendingInputRequestId: inputId
        }),
        inputRequests: [baseInput()]
      })
    );
    const needsYouOwnerAction = projectCollaborativeTaskProgress(
      progressInput({
        viewerRole: "owner",
        task: baseTask({
          status: "blocked_on_action",
          blockedOnActionId: actionId
        }),
        actions: [baseAction({ status: "approval_required" })]
      })
    );
    const needsYouRequesterInput = projectCollaborativeTaskProgress(
      progressInput({
        viewerRole: "requester",
        task: baseTask({
          status: "waiting_for_input",
          pendingInputRequestId: inputId
        }),
        inputRequests: [baseInput()]
      })
    );
    const historyCompleted = projectCollaborativeTaskHistory(
      progressInput({
        task: baseTask({
          status: "completed",
          completedAt: T3,
          result: { summary: "Installed is-odd and verified." },
          continuationSeq: 1
        }),
        providerTurns: [
          baseTurn({ status: "completed", endedAt: T2, checkpointSummary: "Ready to finish." })
        ],
        inputRequests: [baseInput({ status: "answered", answeredAt: T2, answer: "Yes" })]
      })
    );
    const historyDenied = projectCollaborativeTaskHistory(
      progressInput({
        task: baseTask({
          status: "failed",
          completedAt: T3,
          failure: { code: "pairmesh.action_denied", message: "Owner denied the action." }
        }),
        actions: [
          baseAction({
            status: "denied",
            completedAt: T2,
            updatedAt: T2
          })
        ]
      })
    );
    const historyUnknown = projectCollaborativeTaskHistory(
      progressInput({
        task: baseTask({
          status: "failed",
          completedAt: T3,
          failure: {
            code: "pairmesh.action_unknown_outcome",
            message: "Execution outcome is uncertain."
          }
        }),
        actions: [
          baseAction({
            status: "unknown_outcome",
            completedAt: T2,
            updatedAt: T2
          })
        ]
      })
    );

    expect(liveWorking).toMatchObject({ phase: "working_on_request", waitingOn: "provider" });
    expect(liveWaitingRequester).toMatchObject({
      phase: "needs_requester_input",
      waitingOn: "requester"
    });
    expect(needsYouOwnerAction.pendingAction?.provenanceLabel).toBe(
      "Requested by your agent while working on Paul's task."
    );
    expect(needsYouRequesterInput.pendingInput?.interaction).toBe("answer");
    expect(historyCompleted.timeline.length).toBeGreaterThan(0);
    expect(historyDenied.timeline.some((r) => /denied/i.test(r.label))).toBe(true);
    expect(historyUnknown.timeline.some((r) => r.label === "Execution outcome is uncertain.")).toBe(
      true
    );

    await mkdir(EVIDENCE_DIR, { recursive: true });
    const files: Record<string, unknown> = {
      "live-working.json": liveWorking,
      "live-waiting-requester.json": liveWaitingRequester,
      "needs-you-owner-action.json": needsYouOwnerAction,
      "needs-you-requester-input.json": needsYouRequesterInput,
      "history-completed.json": historyCompleted,
      "history-denied.json": historyDenied,
      "history-unknown.json": historyUnknown
    };
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(EVIDENCE_DIR, name), `${JSON.stringify(body, null, 2)}\n`, "utf8");
    }
  });
});
