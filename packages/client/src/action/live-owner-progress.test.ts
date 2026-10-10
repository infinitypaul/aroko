import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  InspectionThreadIdSchema,
  PAIRMESH_METADATA_VERSION,
  PAIRMESH_SECURITY_VERSION,
  PeerIdSchema,
  SessionIdSchema
} from "@pairmesh/protocol";
import { ClaudeCodeAdapter } from "../coding-agent/claude-code-adapter.js";
import { CursorAcpAdapter, type CursorAcpClient } from "../coding-agent/cursor-adapter.js";
import { GeminiCliAdapter } from "../coding-agent/gemini-cli-adapter.js";
import { processPairMeshInspectionRequest } from "../inspect/handler.js";
import { LocalStateStore } from "../state/store.js";
import { LOCAL_STATE_VERSION } from "../session/schemas.js";
import {
  appendReceiverInspectionProgress,
  createReceiverInspectionExecution,
  listReceiverInspectionViews
} from "../session/receiver-inspections.js";
import { mapProviderActivityToProgressEvent } from "./provider-activity.js";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/payment-workspace"
);

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

async function seedReceiverState(stateFile: string): Promise<void> {
  const store = new LocalStateStore({ stateFilePath: stateFile });
  await store.save({
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-WATCH2",
    session: {
      id: sessionId,
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-27T19:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: kelvinId,
        sessionId,
        developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
        joinedAt: "2026-08-27T19:00:00.000Z"
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
      a2aAgentUrl: "http://127.0.0.1:4502",
      isLocal: true,
      serviceLabel: "payment-service"
    },
    peers: [
      {
        participant: {
          id: paulId,
          sessionId,
          developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
          joinedAt: "2026-08-27T19:00:00.000Z"
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
        a2aAgentUrl: "http://127.0.0.1:4501",
        isLocal: false
      }
    ],
    inspectionThreads: [],
    inspectionExecutions: [],
    permissionRequests: [],
    actionExecutions: [],
    actionArtifacts: [],
    collaborativeTasks: [],
    inputRequests: [],
    hostToolCalls: [],
    sessionSecurity: {
      securityVersion: PAIRMESH_SECURITY_VERSION,
      invites: [],
      acceptedInbound: [],
      capabilityGrants: []
    }
  });
}

describe("Stage 19 Prompt 3 — owner mid-run persistence", () => {
  it("persists Claude ProgressEvents while execution remains active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-s19-p3-midflight-"));
    const stateFile = join(dir, "state.json");
    await seedReceiverState(stateFile);
    const store = new LocalStateStore({ stateFilePath: stateFile });

    const paymentPath = join(fixtureWorkspace, "src", "payment.ts");
    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 10_000,
      runProcess: async (input) => {
        const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s" });
        const read = JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "Read",
                input: { file_path: paymentPath }
              }
            ]
          }
        });
        const result = JSON.stringify({
          type: "result",
          subtype: "success",
          result: "payment.ts defines buildSuccessfulPaymentResponse."
        });
        input.onStdoutChunk?.(`${init}\n`);
        await new Promise((r) => setTimeout(r, 30));
        input.onStdoutChunk?.(`${read}\n`);
        await new Promise((r) => setTimeout(r, 80));
        input.onStdoutChunk?.(`${result}\n`);
        return {
          exitCode: 0,
          stdout: `${init}\n${read}\n${result}\n`,
          stderr: ""
        };
      }
    });

    const pending = processPairMeshInspectionRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        threadId: InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4af99"),
        requestId: "req_s19_p3_midflight",
        question: "Where is the payment response built?",
        turnNumber: 1
      },
      adapter,
      store,
      { participantId: paulId }
    );

    let sawRunningWithFileRead = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const state = await store.load();
      const active = listReceiverInspectionViews(state!, "active");
      if (
        active[0]?.status === "running" &&
        active[0].progress.some((event) => event.activityKind === "file.read")
      ) {
        sawRunningWithFileRead = true;
        break;
      }
    }

    const response = await pending;
    expect(response.accepted).toBe(true);
    expect(sawRunningWithFileRead).toBe(true);

    const finalState = await store.load();
    const views = listReceiverInspectionViews(finalState!, "all");
    expect(views[0]?.status).toBe("completed");
    const kinds = views[0]!.progress.map((e) => e.activityKind).filter(Boolean);
    expect(kinds).toContain("worker.started");
    expect(kinds).toContain("file.read");
    // Claude inspect maps completion via execution status; worker.completed is propose-path.
    expect(views[0]!.progress.length).toBeGreaterThanOrEqual(2);
    const sequences = views[0]!.progress
      .map((e) => e.sequence)
      .filter((s): s is number => typeof s === "number");
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]!);
    }
  });

  it("persists Cursor ACP ProgressEvents while execution remains active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-s19-p4-midflight-"));
    const stateFile = join(dir, "state.json");
    await seedReceiverState(stateFile);
    const store = new LocalStateStore({ stateFilePath: stateFile });

    let notificationHandler: ((params: unknown) => void | Promise<void>) | undefined;
    const client: CursorAcpClient = {
      onNotification(method, handler) {
        if (method === "session/update") {
          notificationHandler = handler;
        }
      },
      onRequest() {},
      async request(method) {
        if (method === "initialize" || method === "authenticate") return {};
        if (method === "session/new") return { sessionId: "sess_cursor_mid" };
        if (method === "session/cancel") return {};
        if (method === "session/prompt") {
          await notificationHandler?.({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "I'll inspect the payment flow." }
            }
          });
          await notificationHandler?.({
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "search1",
              kind: "search",
              status: "pending",
              rawInput: { pattern: "ProgressEvent" }
            }
          });
          // Hold prompt open so owner poll can observe running + rich progress.
          await new Promise((r) => setTimeout(r, 120));
          await notificationHandler?.({
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "search1",
              status: "completed"
            }
          });
          await notificationHandler?.({
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "PRIVATE_SENTINEL_DO_NOT_SURFACE" }
            }
          });
          await notificationHandler?.({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: " ProgressEvent is defined in packages/protocol."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        return {};
      },
      async close() {}
    };

    const adapter = new CursorAcpAdapter({
      workspace: fixtureWorkspace,
      mode: "ask",
      timeoutMs: 10_000,
      createAcpClient: () => client
    });

    const pending = processPairMeshInspectionRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        threadId: InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4af97"),
        requestId: "req_s19_p4_midflight",
        question: "Where is ProgressEvent defined?",
        turnNumber: 1
      },
      adapter,
      store,
      { participantId: paulId }
    );

    let sawRunningWithSearch = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const state = await store.load();
      const active = listReceiverInspectionViews(state!, "active");
      if (
        active[0]?.status === "running" &&
        active[0].progress.some(
          (event) =>
            event.activityKind === "search.started" ||
            event.activityKind === "provider.message" ||
            event.activityKind === "file.read"
        )
      ) {
        sawRunningWithSearch = true;
        break;
      }
    }

    const response = await pending;
    expect(response.accepted).toBe(true);
    expect(sawRunningWithSearch).toBe(true);

    const finalState = await store.load();
    const views = listReceiverInspectionViews(finalState!, "all");
    expect(views[0]?.status).toBe("completed");
    const kinds = views[0]!.progress.map((e) => e.activityKind).filter(Boolean);
    expect(kinds).toContain("search.started");
    expect(kinds).toContain("search.completed");
    expect(JSON.stringify(views[0]!.progress)).not.toContain("PRIVATE_SENTINEL_DO_NOT_SURFACE");
    expect(views[0]!.summary ?? "").toContain("ProgressEvent");
  });

  it("fences late progress after terminal inspection status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-s19-p3-fence-"));
    const stateFile = join(dir, "state.json");
    await seedReceiverState(stateFile);
    const store = new LocalStateStore({ stateFilePath: stateFile });

    await store.mutate((state) => {
      const created = createReceiverInspectionExecution({
        requestId: "req_fence",
        threadId: InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4af98"),
        requesterPeerId: paulId,
        requesterPeerName: "Paul",
        turnNumber: 1,
        question: "done",
        now: "2026-08-31T19:00:00.000Z"
      });
      state.inspectionExecutions.push({
        ...created,
        status: "completed",
        updatedAt: "2026-08-31T19:00:01.000Z"
      });
    });

    await store.mutate((state) => {
      appendReceiverInspectionProgress(
        state,
        "req_fence",
        mapProviderActivityToProgressEvent({
          actionId: "req_fence",
          timestamp: "2026-08-31T19:00:02.000Z",
          event: {
            phase: "reading_searching",
            activityKind: "file.read",
            message: "Reading late.ts",
            providerEventId: "late"
          }
        }),
        "2026-08-31T19:00:02.000Z"
      );
    });

    const state = await store.load();
    const record = state!.inspectionExecutions.find((e) => e.requestId === "req_fence");
    expect(record?.progressEvents ?? []).toHaveLength(0);
  });

  it("persists Gemini provider.message while execution remains active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-s19-p5-gemini-mid-"));
    const stateFile = join(dir, "state.json");
    await seedReceiverState(stateFile);
    const store = new LocalStateStore({ stateFilePath: stateFile });

    const adapter = new GeminiCliAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 10_000,
      runProcess: async (input) => {
        const init = JSON.stringify({ type: "init", session_id: "g", model: "m" });
        const msg = JSON.stringify({
          type: "message",
          role: "assistant",
          content: "I'll inspect the ProgressEvent path."
        });
        const read = JSON.stringify({
          type: "tool_use",
          tool_name: "read_file",
          tool_id: "t1",
          parameters: { file_path: join(fixtureWorkspace, "src", "payment.ts") }
        });
        const result = JSON.stringify({ type: "result", status: "success" });
        input.onStdoutChunk?.(`${init}\n`);
        await new Promise((r) => setTimeout(r, 20));
        input.onStdoutChunk?.(`${msg}\n`);
        await new Promise((r) => setTimeout(r, 80));
        input.onStdoutChunk?.(`${read}\n${result}\n`);
        return {
          exitCode: 0,
          stdout: `${init}\n${msg}\n${read}\n${result}\n`,
          stderr: ""
        };
      }
    });

    const pending = processPairMeshInspectionRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        threadId: InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4af96"),
        requestId: "req_s19_p5_gemini_mid",
        question: "Where is ProgressEvent?",
        turnNumber: 1
      },
      adapter,
      store,
      { participantId: paulId }
    );

    let sawRunningWithMessage = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const state = await store.load();
      const active = listReceiverInspectionViews(state!, "active");
      if (
        active[0]?.status === "running" &&
        active[0].progress.some(
          (event) => event.activityKind === "provider.message" || event.activityKind === "file.read"
        )
      ) {
        sawRunningWithMessage = true;
        break;
      }
    }

    const response = await pending;
    expect(response.accepted).toBe(true);
    expect(sawRunningWithMessage).toBe(true);
    const finalState = await store.load();
    const views = listReceiverInspectionViews(finalState!, "all");
    expect(views[0]?.status).toBe("completed");
    expect(views[0]!.progress.some((e) => e.activityKind === "provider.message")).toBe(true);
  });
});
