import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { CodingAgentProposalGenerator, StaticProposalGenerator } from "./proposal/index.js";
import { digestWorkingTree } from "./proposal/working-tree.js";
import { normalizeProposalRelativePath } from "./proposal/paths.js";
import { parseAndNormalizeUnifiedDiff } from "./proposal/unified-diff.js";
import { ActionService } from "./service.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;
const sarahId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af03" as PeerId;

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
);

function peer(id: PeerId): LocalSessionState["peers"][number] {
  return {
    participant: { id } as LocalSessionState["peers"][number]["participant"],
    agent: {} as LocalSessionState["peers"][number]["agent"],
    developer: {} as LocalSessionState["peers"][number]["developer"],
    a2aAgentUrl: "http://127.0.0.1:9/",
    isLocal: false
  };
}

function baseState(localId: PeerId, peerIds: PeerId[]): LocalSessionState {
  return {
    stateVersion: LOCAL_STATE_VERSION,
    sessionCode: "PM-PROPOSE1",
    session: {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-23T12:00:00.000Z",
      status: "active"
    },
    localParticipant: {
      participant: { id: localId } as LocalSessionState["localParticipant"]["participant"],
      agent: {} as LocalSessionState["localParticipant"]["agent"],
      developer: {} as LocalSessionState["localParticipant"]["developer"],
      a2aAgentUrl: "http://127.0.0.1:8/",
      isLocal: true
    },
    peers: peerIds.map(peer),
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

async function cloneFixtureWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-propose-ws-"));
  await cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

async function proposeService(options?: {
  workspace?: string;
  generator?: StaticProposalGenerator | CodingAgentProposalGenerator;
  adapter?: FakeCodingAgentAdapter;
}) {
  const workspace = options?.workspace ?? (await cloneFixtureWorkspace());
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-propose-state-"));
  const stateFilePath = join(dir, "state.json");
  const adapter = options?.adapter ?? new FakeCodingAgentAdapter(workspace);
  const generator = options?.generator ?? new CodingAgentProposalGenerator(adapter);
  const service = new ActionService({
    stateFilePath,
    workspaceRoot: workspace,
    proposalGenerator: generator
  });
  return { service, workspace, adapter, generator, stateFilePath, dir };
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

describe("Stage 15 Prompt 3 — change.propose", () => {
  it("rejects unpaired requester before provider start", async () => {
    const { service, adapter } = await proposeService();
    const state = grantPropose(baseState(kelvinId, []), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b001");
    try {
      await service.requestAction(state, {
        actionId,
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "change.propose",
        parameters: {
          instruction:
            "Change the retry reconstruction so the original payment reference is preserved."
        }
      });
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("pairmesh.authentication_required");
    }
    expect(adapter.getProposeInvocationCount(actionId)).toBe(0);
  });

  it("denies change.propose without invoking provider", async () => {
    const { service, adapter } = await proposeService();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.inspect", "allow_session");
    // change.propose remains deny
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b002");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: { instruction: "Fix retry payment reference reconstruction." }
    });
    expect(result.execution.status).toBe("denied");
    expect(adapter.getProposeInvocationCount(actionId)).toBe(0);
  });

  it("requires repository.inspect before provider start", async () => {
    const { service, adapter } = await proposeService();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.inspect", "deny");
    state = setGrantPolicy(state, paulId, "change.propose", "allow_session");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b003");
    try {
      await service.requestAction(state, {
        actionId,
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "change.propose",
        parameters: { instruction: "Fix retry payment reference reconstruction." }
      });
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("pairmesh.action_not_authorized");
    }
    expect(adapter.getProposeInvocationCount(actionId)).toBe(0);
  });

  it("generates immutable proposal without mutating working tree", async () => {
    const { service, adapter, workspace } = await proposeService();
    const before = await digestWorkingTree(workspace);
    let state = grantPropose(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b010");

    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: {
        instruction:
          "Change the retry reconstruction so the original payment reference is preserved."
      }
    });

    expect(result.execution.status).toBe("completed");
    expect(adapter.getProposeInvocationCount(actionId)).toBe(1);
    expect(result.execution.result?.outputs?.filesChanged).toBe(1);
    expect(result.execution.result?.outputs?.affectedPaths).toContain("src/retry.ts");
    expect(result.execution.result?.outputs?.unifiedDiff).toContain("retryRecord.reference");

    const proposal = await service.getProposal(result.state, { actionId });
    expect(proposal.affectedPaths).toEqual(["src/retry.ts"]);
    expect(proposal.unifiedDiff).toContain("src/retry.ts");
    expect(proposal.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const after = await digestWorkingTree(workspace);
    expect(after.contentDigest).toBe(before.contentDigest);
    expect(after.paths).toEqual(before.paths);

    const retrySource = await readFile(join(workspace, "src", "retry.ts"), "utf8");
    expect(retrySource).toContain('reference: `retry:${retryRecord.customerId ?? "unknown"}`');
  });

  it("records honest headless provider activity on progressEvents", async () => {
    const { service } = await proposeService();
    const state = grantPropose(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b012");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: {
        instruction:
          "Change the retry reconstruction so the original payment reference is preserved."
      }
    });
    expect(result.execution.status).toBe("completed");
    const events = result.execution.progressEvents ?? [];
    const phases = events.map((entry) => entry.phase);
    expect(phases).toContain("provider_started");
    expect(phases).toContain("reading_searching");
    expect(phases).toContain("proposal_preparing");
    expect(phases).toContain("proposal_ready");

    const kinds = events
      .map((entry) => entry.activityKind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
    expect(kinds).toEqual([
      "worker.started",
      "file.read",
      "search.started",
      "search.completed",
      "file.read",
      "proposal.preparing",
      "proposal.ready",
      "worker.completed"
    ]);

    const fileReads = events.filter((entry) => entry.activityKind === "file.read");
    expect(fileReads.every((entry) => entry.visibility === "owner_only")).toBe(true);
    expect(fileReads.map((entry) => entry.safeMetadata?.relativePath)).toEqual([
      "src/retry.ts",
      "src/payment.ts"
    ]);

    const search = events.find((entry) => entry.activityKind === "search.started");
    expect(search?.visibility).toBe("owner_only");
    expect(search?.safeMetadata?.query).toBe("retryRecord.reference");

    const requesterVisible = events.filter((entry) => entry.visibility === "requester_safe");
    expect(
      requesterVisible.every(
        (entry) =>
          entry.activityKind !== "file.read" &&
          entry.activityKind !== "search.started" &&
          entry.activityKind !== "search.completed"
      )
    ).toBe(true);

    const sequences = events
      .map((entry) => entry.sequence)
      .filter((value): value is number => typeof value === "number");
    expect(sequences.length).toBeGreaterThan(5);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]!);
    }
  });

  it("omits path/diff wire content when source_references is denied", async () => {
    const { service } = await proposeService();
    let state = grantPropose(baseState(kelvinId, [paulId]), paulId);
    state = setGrantPolicy(state, paulId, "repository.source_references", "deny");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b011");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: { instruction: "Preserve original payment reference in retry rebuild." }
    });
    expect(result.execution.status).toBe("completed");
    expect(result.execution.result?.outputs?.sourceReferencesAllowed).toBe(false);
    expect(result.execution.result?.outputs?.affectedPaths).toBeUndefined();
    expect(result.execution.result?.outputs?.unifiedDiff).toBeUndefined();
    expect(result.execution.result?.outputs?.filesChanged).toBe(1);
    // Receiver-local retrieval still has the full artifact.
    const local = await service.getProposal(result.state, { actionId });
    expect(local.unifiedDiff.length).toBeGreaterThan(10);
  });

  it("rejects path traversal and absolute paths", async () => {
    await expect(() => normalizeProposalRelativePath("../../outside.txt")).toThrow();
    await expect(() => normalizeProposalRelativePath("/etc/passwd")).toThrow();
    await expect(() => normalizeProposalRelativePath(".env")).toThrow();
    await expect(() => normalizeProposalRelativePath(".git/config")).toThrow();

    const workspace = await cloneFixtureWorkspace();
    const bad = [
      "diff --git a/../../outside.txt b/../../outside.txt",
      "--- a/../../outside.txt",
      "+++ b/../../outside.txt",
      "@@ -0,0 +1 @@",
      "+leak",
      ""
    ].join("\n");
    await expect(parseAndNormalizeUnifiedDiff(bad, workspace)).rejects.toMatchObject({
      code: "pairmesh.proposal_path_denied"
    });
  });

  it("rejects symlink escape targets", async () => {
    const workspace = await cloneFixtureWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "pairmesh-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(join(outside, "secret.txt"), join(workspace, "src", "escaped.txt"));

    const diff = [
      "diff --git a/src/escaped.txt b/src/escaped.txt",
      "--- a/src/escaped.txt",
      "+++ b/src/escaped.txt",
      "@@ -1 +1 @@",
      "-secret",
      "+owned",
      ""
    ].join("\n");

    await expect(parseAndNormalizeUnifiedDiff(diff, workspace)).rejects.toMatchObject({
      code: "pairmesh.proposal_path_denied"
    });
  });

  it("detects artifact content-hash mismatch after tampering", async () => {
    const { service } = await proposeService();
    let state = grantPropose(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b020");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: { instruction: "Preserve original payment reference in retry rebuild." }
    });
    const artifact = result.state.actionArtifacts![0]!;
    const absolute = service.artifactStore.absolutePathForKey(artifact.storageKey);
    // Bypass immutable create flag by rewriting via open path used only in tests.
    const { open } = await import("node:fs/promises");
    const handle = await open(absolute, "r+");
    try {
      await handle.write(Buffer.from("tampered-bytes"), 0);
    } finally {
      await handle.close();
    }
    await expect(service.artifactStore.readBytes(artifact)).rejects.toMatchObject({
      code: "pairmesh.artifact_hash_mismatch"
    });
  });

  it("idempotent retry does not re-invoke provider", async () => {
    const { service, adapter } = await proposeService();
    let state = grantPropose(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b030");
    const input = {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: { instruction: "Preserve original payment reference in retry rebuild." }
    };
    const first = await service.requestAction(state, input);
    expect(first.execution.status).toBe("completed");
    expect(adapter.getProposeInvocationCount(actionId)).toBe(1);
    const second = await service.requestAction(first.state, input);
    expect(second.execution.status).toBe("completed");
    expect(adapter.getProposeInvocationCount(actionId)).toBe(1);
    expect(second.execution.result?.outputs?.artifactId).toBe(
      first.execution.result?.outputs?.artifactId
    );
  });

  it("keeps Kelvin and Sarah action/artifact namespaces isolated", async () => {
    const kelvin = await proposeService();
    const sarahWs = await cloneFixtureWorkspace();
    const sarah = await proposeService({ workspace: sarahWs });

    let kelvinState = grantPropose(baseState(kelvinId, [paulId]), paulId);
    let sarahState = baseState(sarahId, [paulId]);
    sarahState = {
      ...sarahState,
      sessionSecurity: ensureDefaultGrants(sarahState.sessionSecurity!, paulId)
    };
    sarahState = setGrantPolicy(sarahState, paulId, "repository.inspect", "allow_session");
    // Sarah denies change.propose

    const kelvinAction = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b040");
    const sarahAction = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b041");

    const kelvinResult = await kelvin.service.requestAction(kelvinState, {
      actionId: kelvinAction,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: { instruction: "Preserve original payment reference in retry rebuild." }
    });
    expect(kelvinResult.execution.status).toBe("completed");

    const sarahResult = await sarah.service.requestAction(sarahState, {
      actionId: sarahAction,
      requesterParticipantId: paulId,
      targetParticipantId: sarahId,
      actionType: "change.propose",
      parameters: { instruction: "Preserve original payment reference in retry rebuild." }
    });
    expect(sarahResult.execution.status).toBe("denied");
    expect(sarahResult.state.actionArtifacts ?? []).toHaveLength(0);
    expect(kelvinResult.state.actionArtifacts ?? []).toHaveLength(1);

    await expect(
      sarah.service.getProposal(sarahResult.state, { actionId: kelvinAction })
    ).rejects.toMatchObject({ code: "pairmesh.artifact_not_found" });
  });

  it("audit metadata stays free of prompt/diff/credentials", async () => {
    const { service } = await proposeService();
    let state = grantPropose(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b050");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: {
        instruction: "Preserve original payment reference; do not leak TOKEN=super-secret."
      }
    });
    const audited = JSON.stringify(result.execution.auditedEvents);
    expect(audited).not.toContain("TOKEN=super-secret");
    expect(audited).not.toContain("unifiedDiff");
    expect(audited).not.toContain(service.artifactStore.rootDir);
    expect(result.execution.auditedEvents).toEqual(
      expect.arrayContaining(["execution_started", "completed"])
    );
  });

  it("rejects sensitive path proposals via static generator", async () => {
    const workspace = await cloneFixtureWorkspace();
    await mkdir(join(workspace, ".hidden"), { recursive: true });
    const generator = new StaticProposalGenerator({
      summary: "bad",
      providerId: "static",
      unifiedDiff: [
        "diff --git a/.env b/.env",
        "--- a/.env",
        "+++ b/.env",
        "@@ -0,0 +1 @@",
        "+SECRET=1",
        ""
      ].join("\n")
    });
    const { service } = await proposeService({ workspace, generator });
    let state = grantPropose(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4b060");
    const result = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: { instruction: "touch secrets" }
    });
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error?.code).toBe("pairmesh.proposal_path_denied");
    expect(generator.invocationCount).toBe(1);
  });
});
