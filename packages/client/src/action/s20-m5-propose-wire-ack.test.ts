/**
 * S20-M5 — Propose must acknowledge within relay ingress bound (~3s) while
 * provider work continues; same actionId must not double-invoke the provider.
 */
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  PAIRMESH_METADATA_VERSION,
  PeerIdSchema,
  SessionIdSchema,
  type PeerId
} from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { LocalStateStore } from "../state/store.js";
import { StaticProposalGenerator } from "./proposal/index.js";
import { ACTION_WIRE_ACK_BUDGET_MS, processPairMeshActionWireRequest } from "./remote-handler.js";
import { ActionService } from "./service.js";

const paulId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
const kelvinId = PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02");
const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
);

const RELAY_INGRESS_ABORT_MS = 3_000;

const RETRY_COMMENT_DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -43,6 +43,7 @@",
  "   return `rebuildPaymentFromRetryRecord: retryRecord.reference is missing or empty (received: ${JSON.stringify(reference)})`;",
  " }",
  " ",
  "+// Stage20-R1 approve-once fixture marker",
  " export function rebuildPaymentFromRetryRecord(retryRecord: RetryRecord) {",
  '   if (!retryRecord.reference || retryRecord.reference.trim() === "") {',
  "     throw new Error(formatMissingRetryReferenceError(retryRecord.reference));",
  ""
].join("\n");

function peerRecord(
  id: PeerId,
  suffix: string,
  displayName: string
): LocalSessionState["peers"][number] {
  const developerId = `dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${suffix}` as const;
  const agentId = `agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${suffix}` as const;
  return {
    participant: {
      id,
      sessionId,
      developerId,
      agentId,
      joinedAt: "2026-08-23T12:00:00.000Z"
    },
    agent: {
      id: agentId,
      developerId,
      deviceId: `devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${suffix}`,
      projectId: `prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${suffix}`,
      name: `${displayName.toLowerCase()}-agent`,
      adapter: "pairmesh.a2a-demo"
    },
    developer: {
      id: developerId,
      displayName
    },
    a2aAgentUrl: "http://127.0.0.1:9/",
    isLocal: false
  };
}

function baseState(localId: PeerId): LocalSessionState {
  const localSuffix = "02";
  const localDeveloperId = `dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${localSuffix}` as const;
  const localAgentId = `agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${localSuffix}` as const;
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-ABCDEF",
    session: {
      id: sessionId,
      createdBy: localDeveloperId,
      createdAt: "2026-08-23T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: {
        id: localId,
        sessionId,
        developerId: localDeveloperId,
        agentId: localAgentId,
        joinedAt: "2026-08-23T12:00:00.000Z"
      },
      agent: {
        id: localAgentId,
        developerId: localDeveloperId,
        deviceId: `devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${localSuffix}`,
        projectId: `prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af${localSuffix}`,
        name: "kelvin-agent",
        adapter: "pairmesh.a2a-demo"
      },
      developer: {
        id: localDeveloperId,
        displayName: "Kelvin"
      },
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: [peerRecord(paulId, "01", "Paul")],
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

function grantPropose(state: LocalSessionState, requester: PeerId): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "repository.inspect", "allow_session");
  next = setGrantPolicy(next, requester, "change.propose", "allow_session");
  next = setGrantPolicy(next, requester, "repository.source_references", "allow_session");
  return next;
}

async function delayedHarness(delayMs: number) {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-s20m5-ws-"));
  await cp(FIXTURE_ROOT, workspace, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-s20m5-state-"));
  const stateFilePath = join(dir, "state.json");
  const generator = new StaticProposalGenerator(async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return {
      summary: "Adds Stage20 fixture comment above rebuildPaymentFromRetryRecord.",
      providerId: "static",
      unifiedDiff: RETRY_COMMENT_DIFF
    };
  });
  const service = new ActionService({
    stateFilePath,
    workspaceRoot: workspace,
    proposalGenerator: generator
  });
  const stateStore = new LocalStateStore({ stateFilePath });
  let state = grantPropose(baseState(kelvinId), paulId);
  await stateStore.save(state);
  return { service, stateStore, generator };
}

describe("S20-M5 propose wire ack vs provider duration", () => {
  it("returns executing wire ack under ingress budget while provider still runs", async () => {
    const providerDelayMs = 5_000;
    const { service, stateStore, generator } = await delayedHarness(providerDelayMs);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b501");

    const started = Date.now();
    const wire = await processPairMeshActionWireRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        operation: "request",
        actionId,
        actionType: "change.propose",
        parameters: {
          instruction: "Add a comment above rebuildPaymentFromRetryRecord in src/retry.ts only."
        }
      },
      { stateStore, actionService: service, participantId: paulId }
    );
    const ackMs = Date.now() - started;

    expect(wire.accepted).toBe(true);
    if (!wire.accepted) return;
    expect(wire.status).toBe("executing");
    expect(ackMs).toBeLessThan(ACTION_WIRE_ACK_BUDGET_MS);
    expect(ackMs).toBeLessThan(RELAY_INGRESS_ABORT_MS);
    expect(generator.invocationCount).toBeLessThanOrEqual(1);

    let terminal: typeof wire | undefined;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const status = await processPairMeshActionWireRequest(
        {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          sessionId,
          operation: "status",
          actionId
        },
        { stateStore, actionService: service, participantId: paulId }
      );
      if (status.accepted && status.status === "completed") {
        terminal = status;
        break;
      }
    }

    expect(terminal?.accepted).toBe(true);
    if (!terminal?.accepted) return;
    expect(terminal.status).toBe("completed");
    expect(terminal.artifactRefs?.length).toBe(1);
    expect(generator.invocationCount).toBe(1);
  }, 20_000);

  it("same actionId does not invoke provider twice", async () => {
    const { service, stateStore, generator } = await delayedHarness(2_000);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b502");
    const request = {
      metadataVersion: PAIRMESH_METADATA_VERSION,
      sessionId,
      operation: "request" as const,
      actionId,
      actionType: "change.propose",
      parameters: {
        instruction: "Add a comment above rebuildPaymentFromRetryRecord in src/retry.ts only."
      }
    };

    const first = await processPairMeshActionWireRequest(request, {
      stateStore,
      actionService: service,
      participantId: paulId
    });
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;
    expect(first.status).toBe("executing");

    const second = await processPairMeshActionWireRequest(request, {
      stateStore,
      actionService: service,
      participantId: paulId
    });
    expect(second.accepted).toBe(true);
    if (!second.accepted) return;
    expect(["executing", "completed"]).toContain(second.status);

    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      const status = await processPairMeshActionWireRequest(
        {
          metadataVersion: PAIRMESH_METADATA_VERSION,
          sessionId,
          operation: "status",
          actionId
        },
        { stateStore, actionService: service, participantId: paulId }
      );
      if (status.accepted && status.status === "completed") {
        break;
      }
    }

    expect(generator.invocationCount).toBe(1);
  }, 15_000);

  it("fast propose still completes through requestAction", async () => {
    const { service, generator } = await delayedHarness(0);
    let state = grantPropose(baseState(kelvinId), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b503");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: {
        instruction: "Add a comment above rebuildPaymentFromRetryRecord in src/retry.ts only."
      }
    });
    expect(result.execution.status).toBe("completed");
    expect(generator.invocationCount).toBe(1);
  });
});
