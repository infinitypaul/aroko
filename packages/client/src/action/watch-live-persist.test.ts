import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, type ActionExecutionRecord, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { CodingAgentProposalGenerator } from "./proposal/index.js";
import { ActionService } from "./service.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
);

function baseState(): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-WATCH1",
    session: {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-27T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: { id: kelvinId } as LocalSessionState["localParticipant"]["participant"],
      agent: {} as LocalSessionState["localParticipant"]["agent"],
      developer: {} as LocalSessionState["localParticipant"]["developer"],
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: [
      {
        participant: { id: paulId } as LocalSessionState["peers"][number]["participant"],
        agent: {} as LocalSessionState["peers"][number]["agent"],
        developer: {} as LocalSessionState["peers"][number]["developer"],
        a2aAgentUrl: "http://127.0.0.1:9/",
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

describe("Stage 17 Prompt 8 — live ProgressEvent persist", () => {
  it("flushes mid-run provider activity so watch can poll before completion", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-watch-ws-"));
    await cp(FIXTURE_ROOT, workspace, { recursive: true });
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-watch-state-"));
    const snapshots: ActionExecutionRecord[] = [];
    const adapter = new FakeCodingAgentAdapter(workspace);
    const service = new ActionService({
      stateFilePath: join(dir, "state.json"),
      workspaceRoot: workspace,
      proposalGenerator: new CodingAgentProposalGenerator(adapter),
      onLiveActionPersist: (execution) => {
        snapshots.push(structuredClone(execution));
      }
    });

    let state = baseState();
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.inspect", "allow_session");
    state = setGrantPolicy(state, paulId, "change.propose", "allow_session");
    state = setGrantPolicy(state, paulId, "repository.source_references", "allow_session");

    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b088");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: {
        instruction: "Preserve the original payment reference during retry reconstruction."
      }
    });

    expect(result.execution.status).toBe("completed");
    const midRun = snapshots.find(
      (snap) =>
        snap.status === "executing" &&
        (snap.progressEvents ?? []).some((event) => event.activityKind === "file.read")
    );
    expect(midRun).toBeDefined();
    expect(
      snapshots.some(
        (snap) =>
          snap.status === "executing" &&
          (snap.progressEvents ?? []).some((event) => event.activityKind === "search.started")
      )
    ).toBe(true);
    // Live persist must never cancel work — final status remains completed.
    expect(result.execution.cancelRequested).not.toBe(true);
  });
});
