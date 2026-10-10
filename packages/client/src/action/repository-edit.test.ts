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
import { applyHunksToText, parseUnifiedDiffSections } from "./apply/unified-diff-apply.js";
import {
  CodingAgentProposalGenerator,
  PROPOSAL_FORMAT_V1,
  buildCanonicalProposalBytes,
  digestWorkingTree,
  type ProposalArtifactV1
} from "./proposal/index.js";
import { ActionService } from "./service.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;
const sarahId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af03" as PeerId;

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
);

const RETRY_FIX_DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -9,7 +9,7 @@",
  "  */",
  " export function rebuildPaymentFromRetryRecord(retryRecord: RetryRecord) {",
  "   return {",
  '-    reference: `retry:${retryRecord.customerId ?? "unknown"}`,',
  "+    reference: retryRecord.reference,",
  "     customerId: retryRecord.customerId ?? null",
  "   };",
  " }",
  ""
].join("\n");

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
    sessionCode: "PM-EDIT1",
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
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-edit-ws-"));
  await cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

async function editHarness() {
  const workspace = await cloneFixtureWorkspace();
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-edit-state-"));
  const stateFilePath = join(dir, "state.json");
  const adapter = new FakeCodingAgentAdapter(workspace);
  const service = new ActionService({
    stateFilePath,
    workspaceRoot: workspace,
    proposalGenerator: new CodingAgentProposalGenerator(adapter)
  });
  return { service, workspace, adapter, stateFilePath, dir };
}

function grantEdit(state: LocalSessionState, requester: PeerId): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "repository.inspect", "allow_session");
  next = setGrantPolicy(next, requester, "change.propose", "allow_session");
  next = setGrantPolicy(next, requester, "repository.source_references", "allow_session");
  next = setGrantPolicy(next, requester, "repository.edit", "approval_required");
  return next;
}

function grantEditWithoutSourceRefs(
  state: LocalSessionState,
  requester: PeerId
): LocalSessionState {
  let next = grantEdit(state, requester);
  next = setGrantPolicy(next, requester, "repository.source_references", "deny");
  return next;
}

async function createProposalArtifact(
  service: ActionService,
  state: LocalSessionState,
  options: {
    actionId: ReturnType<typeof ActionIdSchema.parse>;
    unifiedDiff?: string;
    affectedPaths?: string[];
    summary?: string;
  }
) {
  const affectedPaths = options.affectedPaths ?? ["src/retry.ts"];
  const proposal: ProposalArtifactV1 = {
    format: PROPOSAL_FORMAT_V1,
    actionId: options.actionId,
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    createdAt: "2026-08-23T12:00:00.000Z",
    summary: options.summary ?? "Preserve original payment reference on retry rebuild.",
    affectedPaths,
    unifiedDiff: options.unifiedDiff ?? RETRY_FIX_DIFF,
    stats: { filesChanged: affectedPaths.length, additions: 1, deletions: 1 }
  };
  const bytes = buildCanonicalProposalBytes(proposal);
  return service.createTestArtifact(state, {
    actionId: options.actionId,
    bytes,
    artifactType: "patch_diff"
  });
}

describe("Stage 15 Prompt 4 — unified diff apply unit", () => {
  it("applies a strict hunk and rejects drifted context", () => {
    const original = "a\nb\nc\n";
    const sections = parseUnifiedDiffSections(
      [
        "diff --git a/f.txt b/f.txt",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "+B",
        " c",
        ""
      ].join("\n")
    );
    expect(applyHunksToText(original, sections[0]!.hunks)).toBe("a\nB\nc\n");
    try {
      applyHunksToText("a\nX\nc\n", sections[0]!.hunks);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("pairmesh.proposal_conflict");
    }
  });
});

describe("Stage 15 Prompt 4 — repository.edit", () => {
  it("rejects unauthenticated requester before apply", async () => {
    const { service } = await editHarness();
    let state = grantEdit(baseState(kelvinId, []), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c001");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    await expect(
      service.requestAction(state, {
        actionId,
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "repository.edit",
        artifactRef: {
          artifactId: created.artifact.artifactId,
          contentHash: created.artifact.contentHash,
          artifactType: "patch_diff"
        }
      })
    ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);
  });

  it("default deny and allow_session cannot execute mutation", async () => {
    const { service } = await editHarness();
    let state = baseState(kelvinId, [paulId]);
    state = {
      ...state,
      sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, paulId)
    };
    state = setGrantPolicy(state, paulId, "repository.inspect", "allow_session");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c002");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const denied = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    expect(denied.execution.status).toBe("denied");
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);

    expect(() => setGrantPolicy(state, paulId, "repository.edit", "allow_session")).toThrow(
      /allow_session/
    );
  });

  it("approval required; exact apply; replay does not re-apply; WT only target changes", async () => {
    const { service, workspace } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const proposeId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c010");
    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c011");

    const before = await digestWorkingTree(workspace);
    const created = await createProposalArtifact(service, state, { actionId: proposeId });
    state = created.state;
    const artifactRef = {
      artifactId: created.artifact.artifactId,
      contentHash: created.artifact.contentHash,
      artifactType: created.artifact.artifactType as "patch_diff"
    };

    const pending = await service.requestAction(state, {
      actionId: editId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef
    });
    expect(pending.execution.status).toBe("approval_required");
    expect(pending.execution.approvalBinding?.normalizedTargetPaths).toEqual(["src/retry.ts"]);
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);
    expect((await digestWorkingTree(workspace)).contentDigest).toBe(before.contentDigest);

    const local = await service.getProposal(pending.state, {
      artifactId: created.artifact.artifactId
    });
    expect(local.summary).toMatch(/payment reference/i);
    expect(local.unifiedDiff).toContain("retryRecord.reference");

    const approved = await service.approveAction(pending.state, {
      actionId: editId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
    expect(approved.execution.executorInvocationCount).toBe(1);

    const retryText = await readFile(join(workspace, "src/retry.ts"), "utf8");
    expect(retryText).toContain("reference: retryRecord.reference");
    expect(retryText).not.toContain("retry:${retryRecord.customerId");

    const after = await digestWorkingTree(workspace);
    expect(after.contentDigest).not.toBe(before.contentDigest);
    expect(after.paths.filter((p) => p !== "src/retry.ts").sort()).toEqual(
      before.paths.filter((p) => p !== "src/retry.ts").sort()
    );

    const replay = await service.requestAction(approved.state, {
      actionId: editId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef
    });
    expect(replay.execution.status).toBe("completed");
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
    expect((await digestWorkingTree(workspace)).contentDigest).toBe(after.contentDigest);
  });

  it("rejects allow-session decision for repository.edit", async () => {
    const { service } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c012");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    await expect(
      service.approveAction(pending.state, { actionId, decision: "allow-session" })
    ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);
  });

  it("rejects artifact hash tamper after approval binding", async () => {
    const { service, workspace } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c013");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    const before = await digestWorkingTree(workspace);
    const absolute = service.artifactStore.absolutePathForKey(created.artifact.storageKey);
    await writeFile(absolute, Buffer.from('{"tampered":true}'));

    await expect(
      service.approveAction(pending.state, { actionId, decision: "allow-once" })
    ).rejects.toMatchObject({ code: "pairmesh.artifact_hash_mismatch" });
    expect((await digestWorkingTree(workspace)).contentDigest).toBe(before.contentDigest);
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);
  });

  it("rejects repository drift / conflicting local edits", async () => {
    const { service, workspace } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c014");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    await writeFile(
      join(workspace, "src/retry.ts"),
      "export function rebuildPaymentFromRetryRecord() { return { reference: 'local' }; }\n"
    );
    const before = await digestWorkingTree(workspace);
    const applied = await service.approveAction(pending.state, {
      actionId,
      decision: "allow-once"
    });
    expect(applied.execution.status).toBe("failed");
    expect(applied.execution.error?.code).toBe("pairmesh.proposal_conflict");
    expect((await digestWorkingTree(workspace)).contentDigest).toBe(before.contentDigest);
  });

  it("rejects expired approval", async () => {
    const { service, workspace } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c015");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    const before = await digestWorkingTree(workspace);
    const forced = {
      ...pending.state,
      actionExecutions: pending.state.actionExecutions!.map((entry) =>
        entry.actionId === actionId
          ? {
              ...entry,
              approvalBinding: {
                ...entry.approvalBinding!,
                expiresAt: "2020-01-01T00:00:00.000Z"
              }
            }
          : entry
      )
    };
    const result = await service.approveAction(forced, { actionId, decision: "allow-once" });
    expect(result.execution.status).toBe("expired");
    expect((await digestWorkingTree(workspace)).contentDigest).toBe(before.contentDigest);
  });

  it("revocation before apply prevents mutation", async () => {
    const { service, workspace } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c016");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    const revoked = { ...pending.state, peers: [] };
    const before = await digestWorkingTree(workspace);
    await expect(
      service.approveAction(revoked, { actionId, decision: "allow-once" })
    ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });
    expect((await digestWorkingTree(workspace)).contentDigest).toBe(before.contentDigest);
  });

  it("policy deny before apply invalidates allow-once approval", async () => {
    const { service, workspace } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c017");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    const deniedPolicy = setGrantPolicy(pending.state, paulId, "repository.edit", "deny");
    const before = await digestWorkingTree(workspace);
    await expect(
      service.approveAction(deniedPolicy, { actionId, decision: "allow-once" })
    ).rejects.toMatchObject({ code: "pairmesh.action_not_authorized" });
    expect((await digestWorkingTree(workspace)).contentDigest).toBe(before.contentDigest);
  });

  it("cancel before apply; cancel during multi-file apply → partial", async () => {
    const { service, workspace } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    await writeFile(join(workspace, "src/other.ts"), "export const x = 1;\n");
    const multiDiff = [
      "diff --git a/src/other.ts b/src/other.ts",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1 +1 @@",
      "-export const x = 1;",
      "+export const x = 2;",
      RETRY_FIX_DIFF.trimEnd(),
      ""
    ].join("\n");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c018");
    const created = await createProposalArtifact(service, state, {
      actionId,
      unifiedDiff: multiDiff,
      affectedPaths: ["src/other.ts", "src/retry.ts"]
    });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    const cancelled = service.cancelAction(pending.state, actionId);
    expect(cancelled.execution.status).toBe("cancelled");
    expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);

    // Fresh action for mid-apply cancel via fault after first write
    const actionId2 = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c019");
    const created2 = await createProposalArtifact(service, state, {
      actionId: actionId2,
      unifiedDiff: multiDiff,
      affectedPaths: ["src/other.ts", "src/retry.ts"]
    });
    let state2 = created2.state;
    const pending2 = await service.requestAction(state2, {
      actionId: actionId2,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created2.artifact.artifactId,
        contentHash: created2.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    service.repositoryEditExecutor!.setFaultMode("after_first_write");
    const partial = await service.approveAction(pending2.state, {
      actionId: actionId2,
      decision: "allow-once"
    });
    expect(partial.execution.status).toBe("partially_completed");
    expect(partial.execution.result?.partial).toBe(true);
    service.repositoryEditExecutor!.setFaultMode("none");

    const replay = await service.requestAction(partial.state, {
      actionId: actionId2,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created2.artifact.artifactId,
        contentHash: created2.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    expect(replay.execution.status).toBe("partially_completed");
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
  });

  it("unknown_outcome after writes does not auto-retry", async () => {
    const { service, workspace } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c020");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    service.repositoryEditExecutor!.setFaultMode("after_writes_before_result");
    const unknown = await service.approveAction(pending.state, {
      actionId,
      decision: "allow-once"
    });
    expect(unknown.execution.status).toBe("unknown_outcome");
    service.repositoryEditExecutor!.setFaultMode("none");
    const retry = await service.requestAction(unknown.state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    expect(retry.execution.status).toBe("unknown_outcome");
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
    // File may already be mutated; do not re-apply.
    const text = await readFile(join(workspace, "src/retry.ts"), "utf8");
    expect(text).toContain("retryRecord.reference");
  });

  it("cross-peer artifact/approval isolation", async () => {
    const { service } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId, sarahId]), paulId);
    state = grantEdit(state, sarahId);
    const kelvinAction = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c021");
    const sarahAction = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c022");
    const kelvinArt = await createProposalArtifact(service, state, { actionId: kelvinAction });
    state = kelvinArt.state;
    const sarahArt = await createProposalArtifact(service, state, { actionId: sarahAction });
    state = sarahArt.state;

    const pending = await service.requestAction(state, {
      actionId: kelvinAction,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: kelvinArt.artifact.artifactId,
        contentHash: kelvinArt.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });

    await expect(
      service.requestAction(pending.state, {
        actionId: kelvinAction,
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "repository.edit",
        artifactRef: {
          artifactId: sarahArt.artifact.artifactId,
          contentHash: sarahArt.artifact.contentHash,
          artifactType: "patch_diff"
        }
      })
    ).rejects.toMatchObject({ code: "pairmesh.action_conflict" });
  });

  it("source privacy filters apply result without source_references", async () => {
    const { service } = await editHarness();
    let state = grantEditWithoutSourceRefs(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c023");
    const created = await createProposalArtifact(service, state, { actionId });
    state = created.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    const approved = await service.approveAction(pending.state, {
      actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(approved.execution.result?.outputs?.appliedPaths).toBeUndefined();
    expect(approved.execution.result?.outputs?.affectedPaths).toBeUndefined();
    expect(approved.execution.result?.outputs?.artifactId).toBe(created.artifact.artifactId);
    expect(approved.execution.result?.outputs?.filesChanged).toBe(1);
  });

  it("rejects sensitive path and symlink mutation at apply", async () => {
    const { service, workspace } = await editHarness();
    await writeFile(join(workspace, ".env"), "SECRET=1\n");
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c024");
    const envDiff = [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-SECRET=1",
      "+SECRET=2",
      ""
    ].join("\n");
    const created = await service.createTestArtifact(state, {
      actionId,
      bytes: Buffer.from(
        JSON.stringify({
          format: PROPOSAL_FORMAT_V1,
          actionId,
          requesterParticipantId: paulId,
          targetParticipantId: kelvinId,
          createdAt: "2026-08-23T12:00:00.000Z",
          summary: "tamper env",
          affectedPaths: [".env"],
          unifiedDiff: envDiff,
          stats: { filesChanged: 1, additions: 1, deletions: 1 }
        })
      ),
      artifactType: "patch_diff"
    });
    state = created.state;
    const envPending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    const envApplied = await service.approveAction(envPending.state, {
      actionId,
      decision: "allow-once"
    });
    expect(envApplied.execution.status).toBe("failed");
    expect(envApplied.execution.error?.code).toBe("pairmesh.proposal_path_denied");

    const linkId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c025");
    await mkdir(join(workspace, "outside"), { recursive: true });
    await writeFile(join(workspace, "outside/secret.txt"), "x\n");
    await symlink(join(workspace, "outside/secret.txt"), join(workspace, "src/link.txt"));
    const linkDiff = [
      "diff --git a/src/link.txt b/src/link.txt",
      "--- a/src/link.txt",
      "+++ b/src/link.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      ""
    ].join("\n");
    const linkArt = await service.createTestArtifact(state, {
      actionId: linkId,
      bytes: Buffer.from(
        JSON.stringify({
          format: PROPOSAL_FORMAT_V1,
          actionId: linkId,
          requesterParticipantId: paulId,
          targetParticipantId: kelvinId,
          createdAt: "2026-08-23T12:00:00.000Z",
          summary: "symlink",
          affectedPaths: ["src/link.txt"],
          unifiedDiff: linkDiff,
          stats: { filesChanged: 1, additions: 1, deletions: 1 }
        })
      ),
      artifactType: "patch_diff"
    });
    const pending = await service.requestAction(linkArt.state, {
      actionId: linkId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: linkArt.artifact.artifactId,
        contentHash: linkArt.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    const applied = await service.approveAction(pending.state, {
      actionId: linkId,
      decision: "allow-once"
    });
    expect(applied.execution.status).toBe("failed");
    expect(applied.execution.error?.code).toMatch(/path_denied|unsupported/);
  });

  it("changed material with same actionId conflicts", async () => {
    const { service } = await editHarness();
    let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c026");
    const a = await createProposalArtifact(service, state, { actionId });
    state = a.state;
    const b = await createProposalArtifact(service, state, {
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c027"),
      summary: "Different proposal"
    });
    state = b.state;
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: a.artifact.artifactId,
        contentHash: a.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    await expect(
      service.requestAction(pending.state, {
        actionId,
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "repository.edit",
        artifactRef: {
          artifactId: b.artifact.artifactId,
          contentHash: b.artifact.contentHash,
          artifactType: "patch_diff"
        }
      })
    ).rejects.toMatchObject({ code: "pairmesh.action_conflict" });
  });

  it("Claude propose adapter remains read-only (no Write/Edit/Bash)", async () => {
    const { ClaudeCodeAdapter } = await import("../coding-agent/claude-code-adapter.js");
    const fixtureWorkspace = await cloneFixtureWorkspace();
    let captured: string[] = [];
    const adapter = new ClaudeCodeAdapter({
      workspace: fixtureWorkspace,
      timeoutMs: 5_000,
      runProcess: async (input) => {
        captured = input.args;
        return {
          stdout: JSON.stringify({
            result: [
              "<<<PAIRMESH_PROPOSAL_PROVIDER_V1>>>",
              JSON.stringify({
                version: "pairmesh.proposal-provider.v1",
                summary: "Preserve payment reference",
                files: [
                  {
                    path: "src/retry.ts",
                    patch: [
                      "@@ -9,7 +9,7 @@",
                      "  */",
                      " export function rebuildPaymentFromRetryRecord(retryRecord: RetryRecord) {",
                      "   return {",
                      '-    reference: `retry:${retryRecord.customerId ?? "unknown"}`,',
                      "+    reference: retryRecord.reference,",
                      "     customerId: retryRecord.customerId ?? null",
                      "   };",
                      " }"
                    ].join("\n")
                  }
                ]
              }),
              "<<<END_PAIRMESH_PROPOSAL_PROVIDER_V1>>>"
            ].join("\n"),
            is_error: false
          }),
          stderr: "",
          exitCode: 0
        };
      }
    });
    await adapter.proposeChange({
      instruction: "fix retry",
      requestId: "req_edit_regression"
    });
    expect(captured).toContain("dontAsk");
    expect(captured).toContain("Read,Grep,Glob");
    expect(captured.join(" ")).not.toMatch(/\bWrite\b/);
    expect(captured.join(" ")).not.toMatch(/\bEdit\b/);
    expect(captured.join(" ")).not.toMatch(/\bBash\b/);
  });
});
