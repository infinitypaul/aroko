import { mkdir, mkdtemp, readFile, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, PAIRMESH_GRANTABLE_CAPABILITIES, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { orderLifecycleSections } from "./apply/lifecycle-ops.js";
import { parseUnifiedDiffSections } from "./apply/unified-diff-apply.js";
import { preparePatchApply, commitPatchApply } from "./apply/patch-applicator.js";
import { CodingAgentProposalGenerator } from "./proposal/index.js";
import { parseAndNormalizeUnifiedDiff } from "./proposal/unified-diff.js";
import { ActionService } from "./service.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;

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
    sessionCode: "PM-R3FS",
    session: {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4ar3f",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4ar3f",
      createdAt: "2026-09-02T12:00:00.000Z",
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

async function freshWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-r3-ws-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "keep.ts"), "export const keep = 1;\n", "utf8");
  await writeFile(join(dir, "src", "old.ts"), "export const old = true;\n", "utf8");
  await writeFile(join(dir, "src", "gone.ts"), "export const gone = true;\n", "utf8");
  return dir;
}

function createDiff(path: string, contents: string): string {
  const body = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  const lines = body.length === 0 ? [] : body.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length || 1} @@`,
    ...(lines.length === 0 ? ["+"] : lines.map((line) => `+${line}`)),
    ""
  ].join("\n");
}

function deleteDiff(path: string, contents: string): string {
  const body = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  const lines = body.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ /dev/null`,
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
    ""
  ].join("\n");
}

function renameDiff(src: string, dst: string): string {
  return [
    `diff --git a/${src} b/${dst}`,
    `rename from ${src}`,
    `rename to ${dst}`,
    `--- a/${src}`,
    `+++ b/${dst}`,
    ""
  ].join("\n");
}

function modifyDiff(path: string, fromLine: string, toLine: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1 +1 @@`,
    `-${fromLine}`,
    `+${toLine}`,
    ""
  ].join("\n");
}

describe("R3 filesystem lifecycle", () => {
  it("keeps peer-grantable permissions at 6 after R4", () => {
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toHaveLength(6);
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toEqual([
      "repository.inspect",
      "repository.source_references",
      "change.propose",
      "repository.edit",
      "tests.run",
      "process.execute"
    ]);
  });

  it("normalizes CREATE / DELETE / RENAME and rejects rename+edit", async () => {
    const workspace = await freshWorkspace();
    const create = await parseAndNormalizeUnifiedDiff(
      createDiff("src/nested/new.ts", "export const neu = 1;\n"),
      workspace
    );
    expect(create.files[0]?.kind).toBe("create");
    expect(create.normalizedDiff).toContain("--- /dev/null");

    const del = await parseAndNormalizeUnifiedDiff(
      deleteDiff("src/gone.ts", "export const gone = true;\n"),
      workspace
    );
    expect(del.files[0]?.kind).toBe("delete");

    const ren = await parseAndNormalizeUnifiedDiff(
      renameDiff("src/old.ts", "src/renamed.ts"),
      workspace
    );
    expect(ren.files[0]?.kind).toBe("rename");
    expect(ren.affectedPaths).toEqual(["src/old.ts", "src/renamed.ts"]);

    await expect(
      parseAndNormalizeUnifiedDiff(
        [
          "diff --git a/src/old.ts b/src/renamed.ts",
          "rename from src/old.ts",
          "rename to src/renamed.ts",
          "--- a/src/old.ts",
          "+++ b/src/renamed.ts",
          "@@ -1 +1 @@",
          "-export const old = true;",
          "+export const edited = true;",
          ""
        ].join("\n"),
        workspace
      )
    ).rejects.toMatchObject({ code: "pairmesh.proposal_invalid" });
  });

  it("orders CREATE → MODIFY → RENAME → DELETE for disjoint paths", () => {
    const sections = parseUnifiedDiffSections(
      [
        modifyDiff("src/keep.ts", "export const keep = 1;", "export const keep = 2;"),
        createDiff("src/new.ts", "export const neu = 1;\n"),
        deleteDiff("src/gone.ts", "export const gone = true;\n"),
        renameDiff("src/old.ts", "src/renamed.ts")
      ].join("")
    );
    const ordered = orderLifecycleSections(sections);
    expect(
      ordered.map((s) =>
        s.isRename ? "rename" : s.isCreate ? "create" : s.isDelete ? "delete" : "modify"
      )
    ).toEqual(["create", "modify", "rename", "delete"]);
  });

  it("applies multi-op proposal exactly once", async () => {
    const workspace = await freshWorkspace();
    const unified = [
      modifyDiff("src/keep.ts", "export const keep = 1;", "export const keep = 2;"),
      createDiff("src/payment/validators/New.ts", "export const neu = true;\n"),
      deleteDiff("src/gone.ts", "export const gone = true;\n"),
      renameDiff("src/old.ts", "src/moved.ts")
    ].join("");
    const normalized = await parseAndNormalizeUnifiedDiff(unified, workspace);
    const plan = await preparePatchApply({
      workspaceRoot: workspace,
      unifiedDiff: normalized.normalizedDiff,
      allowedPaths: normalized.affectedPaths
    });
    expect(plan.ops.map((op) => op.kind)).toEqual(["create", "modify", "rename", "delete"]);
    const result = await commitPatchApply(plan);
    expect(result.partial).toBe(false);
    expect(await readFile(join(workspace, "src/keep.ts"), "utf8")).toContain("keep = 2");
    expect(await readFile(join(workspace, "src/payment/validators/New.ts"), "utf8")).toContain(
      "neu"
    );
    expect(await readFile(join(workspace, "src/moved.ts"), "utf8")).toContain("old = true");
    await expect(access(join(workspace, "src/gone.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(workspace, "src/old.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses CREATE overwrite, DELETE stale, RENAME collision, path escape", async () => {
    const workspace = await freshWorkspace();
    await expect(
      preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: (
          await parseAndNormalizeUnifiedDiff(createDiff("src/keep.ts", "x\n"), workspace)
        ).normalizedDiff,
        allowedPaths: ["src/keep.ts"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.repository_edit_unsupported_operation" });

    await writeFile(join(workspace, "src/gone.ts"), "changed\n", "utf8");
    await expect(
      preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: (
          await parseAndNormalizeUnifiedDiff(
            deleteDiff("src/gone.ts", "export const gone = true;\n"),
            workspace
          )
        ).normalizedDiff,
        allowedPaths: ["src/gone.ts"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.proposal_conflict" });

    await writeFile(join(workspace, "src/moved.ts"), "exists\n", "utf8");
    await expect(
      preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: (
          await parseAndNormalizeUnifiedDiff(renameDiff("src/old.ts", "src/moved.ts"), workspace)
        ).normalizedDiff,
        allowedPaths: ["src/old.ts", "src/moved.ts"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.repository_edit_unsupported_operation" });

    await expect(
      parseAndNormalizeUnifiedDiff(createDiff("../escape.ts", "nope\n"), workspace)
    ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });
  });

  it("refuses symlink parent create", async () => {
    const workspace = await freshWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "pairmesh-r3-out-"));
    await symlink(outside, join(workspace, "src", "linkdir"));
    await expect(
      parseAndNormalizeUnifiedDiff(createDiff("src/linkdir/x.ts", "x\n"), workspace)
    ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });
  });

  it("injected failure before DELETE leaves delete target intact", async () => {
    const workspace = await freshWorkspace();
    const unified = [
      createDiff("src/new.ts", "export const neu = 1;\n"),
      modifyDiff("src/keep.ts", "export const keep = 1;", "export const keep = 2;"),
      renameDiff("src/old.ts", "src/renamed.ts"),
      deleteDiff("src/gone.ts", "export const gone = true;\n")
    ].join("");
    const normalized = await parseAndNormalizeUnifiedDiff(unified, workspace);
    const plan = await preparePatchApply({
      workspaceRoot: workspace,
      unifiedDiff: normalized.normalizedDiff,
      allowedPaths: normalized.affectedPaths
    });
    // ops: create, modify, rename, delete → fail before op 4
    await expect(commitPatchApply(plan, { faultMode: "before_op_4" })).rejects.toMatchObject({
      code: "pairmesh.repository_apply_partial"
    });
    expect(await readFile(join(workspace, "src/gone.ts"), "utf8")).toContain("gone = true");
    expect(await readFile(join(workspace, "src/new.ts"), "utf8")).toContain("neu");
    expect(await readFile(join(workspace, "src/renamed.ts"), "utf8")).toContain("old = true");
  });

  it("Approve once applies multi-op via ActionService and rejects allow-session", async () => {
    const workspace = await freshWorkspace();
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-r3-state-"));
    const adapter = new FakeCodingAgentAdapter(workspace);
    const service = new ActionService({
      stateFilePath: join(dir, "state.json"),
      workspaceRoot: workspace,
      proposalGenerator: new CodingAgentProposalGenerator(adapter)
    });
    let state = grantEditLike(baseState(kelvinId, [paulId]), paulId);

    const unified = [
      createDiff("src/brand.ts", "export const brand = 1;\n"),
      modifyDiff("src/keep.ts", "export const keep = 1;", "export const keep = 9;"),
      renameDiff("src/old.ts", "src/legacy.ts"),
      deleteDiff("src/gone.ts", "export const gone = true;\n")
    ].join("");
    const normalized = await parseAndNormalizeUnifiedDiff(unified, workspace);
    const proposal = {
      format: "pairmesh.proposal.v1" as const,
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c101"),
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      createdAt: "2026-09-02T12:00:00.000Z",
      summary: "R3 multi-op lifecycle",
      affectedPaths: normalized.affectedPaths,
      unifiedDiff: normalized.normalizedDiff,
      stats: {
        filesChanged: normalized.files.length,
        additions: normalized.additions,
        deletions: normalized.deletions
      }
    };
    const { buildCanonicalProposalBytes } = await import("./proposal/schema.js");
    const bytes = buildCanonicalProposalBytes(proposal);
    const created = await service.createTestArtifact(state, {
      actionId: proposal.actionId,
      bytes,
      artifactType: "patch_diff"
    });
    state = created.state;

    const editId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c102");
    const pending = await service.requestAction(state, {
      actionId: editId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    expect(pending.execution.status).toBe("approval_required");

    await expect(
      service.approveAction(pending.state, { actionId: editId, decision: "allow-session" })
    ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });

    const approved = await service.approveAction(pending.state, {
      actionId: editId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
    expect(await readFile(join(workspace, "src/brand.ts"), "utf8")).toContain("brand");
    expect(await readFile(join(workspace, "src/keep.ts"), "utf8")).toContain("keep = 9");
    expect(await readFile(join(workspace, "src/legacy.ts"), "utf8")).toContain("old = true");
    await expect(access(join(workspace, "src/gone.ts"))).rejects.toMatchObject({ code: "ENOENT" });

    const replay = await service.requestAction(approved.state, {
      actionId: editId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "repository.edit",
      artifactRef: {
        artifactId: created.artifact.artifactId,
        contentHash: created.artifact.contentHash,
        artifactType: "patch_diff"
      }
    });
    expect(replay.execution.status).toBe("completed");
    expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
  });
});

function grantEditLike(state: LocalSessionState, requester: PeerId): LocalSessionState {
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
