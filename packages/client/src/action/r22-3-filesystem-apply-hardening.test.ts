import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, PAIRMESH_GRANTABLE_CAPABILITIES, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { commitPatchApply, preparePatchApply } from "./apply/patch-applicator.js";
import { writeMutationJournal } from "./apply/mutation-journal.js";
import {
  isSensitiveRelativePath,
  normalizeProposalRelativePath,
  SENSITIVE_PATH_SEGMENTS
} from "./proposal/paths.js";
import {
  PROPOSAL_FORMAT_V1,
  buildCanonicalProposalBytes,
  type ProposalArtifactV1
} from "./proposal/schema.js";
import { ActionService } from "./service.js";
import { isAllowSessionForbidden } from "../../control-web/people-present.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af31" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af32" as PeerId;

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
    sessionCode: "PM-R22-3",
    session: {
      id: "ses_r22_3",
      createdBy: "dev_r22_3",
      createdAt: "2026-09-12T12:00:00.000Z",
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

function grantEdit(state: LocalSessionState, requester: PeerId): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "repository.edit", "approval_required");
  return next;
}

async function harness() {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r22-3-ws-"));
  await mkdir(join(workspace, "src", "nested"), { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(workspace, "src", "b.ts"), "export const b = 1;\n", "utf8");
  await writeFile(join(workspace, "src", "nested", "c.ts"), "export const c = 1;\n", "utf8");
  await writeFile(join(workspace, "src", "gone.ts"), "export const gone = 1;\n", "utf8");
  await writeFile(join(workspace, "src", "old.ts"), "export const old = 1;\n", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-r22-3-state-"));
  const service = new ActionService({
    stateFilePath: join(dir, "state.json"),
    workspaceRoot: workspace
  });
  return { service, workspace, stateDir: dir };
}

async function createProposalArtifact(
  service: ActionService,
  state: LocalSessionState,
  options: {
    actionId: ReturnType<typeof ActionIdSchema.parse>;
    unifiedDiff: string;
    affectedPaths: string[];
    summary?: string;
  }
) {
  const proposal: ProposalArtifactV1 = {
    format: PROPOSAL_FORMAT_V1,
    actionId: options.actionId,
    requesterParticipantId: paulId,
    targetParticipantId: kelvinId,
    createdAt: "2026-09-12T12:00:00.000Z",
    summary: options.summary ?? "R22-3 proposal",
    affectedPaths: options.affectedPaths,
    unifiedDiff: options.unifiedDiff,
    stats: {
      filesChanged: options.affectedPaths.length,
      additions: 1,
      deletions: 1
    }
  };
  const bytes = buildCanonicalProposalBytes(proposal);
  return service.createTestArtifact(state, {
    actionId: options.actionId,
    bytes,
    artifactType: "patch_diff"
  });
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

describe("R22-3 — filesystem / apply hardening", () => {
  describe(".pairmesh control-plane deny", () => {
    it("denies .pairmesh in sensitive policy and normalize", () => {
      expect(SENSITIVE_PATH_SEGMENTS.has(".pairmesh")).toBe(true);
      expect(isSensitiveRelativePath(".pairmesh/state.json")).toBe(true);
      expect(isSensitiveRelativePath(".pairmesh/config.json")).toBe(true);
      expect(isSensitiveRelativePath("src/ok.ts")).toBe(false);

      for (const path of [".pairmesh/foo", ".pairmesh/state.json", "./.pairmesh/state.json"]) {
        expect(() => normalizeProposalRelativePath(path)).toThrow(/sensitive|denied/i);
      }
      // Traversal forms fail closed before/at sensitive check.
      expect(() => normalizeProposalRelativePath(".pairmesh/../.pairmesh/config.json")).toThrow();
      expect(() => normalizeProposalRelativePath("foo/../.pairmesh/state.json")).toThrow(/\.\./);
    });

    it("rejects create/modify/delete/rename involving .pairmesh at prepare", async () => {
      const { workspace } = await harness();
      await mkdir(join(workspace, ".pairmesh"), { recursive: true });
      await writeFile(join(workspace, ".pairmesh", "state.json"), "{}\n", "utf8");

      await expect(
        preparePatchApply({
          workspaceRoot: workspace,
          unifiedDiff: createDiff(".pairmesh/foo", "x\n"),
          allowedPaths: [".pairmesh/foo"]
        })
      ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });

      await expect(
        preparePatchApply({
          workspaceRoot: workspace,
          unifiedDiff: modifyDiff(".pairmesh/state.json", "{}", "{}\n"),
          allowedPaths: [".pairmesh/state.json"]
        })
      ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });

      await expect(
        preparePatchApply({
          workspaceRoot: workspace,
          unifiedDiff: deleteDiff(".pairmesh/state.json", "{}\n"),
          allowedPaths: [".pairmesh/state.json"]
        })
      ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });

      await expect(
        preparePatchApply({
          workspaceRoot: workspace,
          unifiedDiff: renameDiff("src/a.ts", ".pairmesh/stolen.ts"),
          allowedPaths: ["src/a.ts", ".pairmesh/stolen.ts"]
        })
      ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });

      await expect(
        preparePatchApply({
          workspaceRoot: workspace,
          unifiedDiff: renameDiff(".pairmesh/state.json", "src/leaked.json"),
          allowedPaths: [".pairmesh/state.json", "src/leaked.json"]
        })
      ).rejects.toMatchObject({ code: "pairmesh.proposal_path_denied" });
    });
  });

  describe("ancestor TOCTOU at commit", () => {
    it("rejects modify when parent swapped to external symlink", async () => {
      const { workspace } = await harness();
      const outside = await mkdtemp(join(tmpdir(), "pairmesh-r22-3-out-"));
      await writeFile(join(outside, "c.ts"), "export const c = 1;\n", "utf8");

      const plan = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: modifyDiff("src/nested/c.ts", "export const c = 1;", "export const c = 2;"),
        allowedPaths: ["src/nested/c.ts"]
      });

      await rm(join(workspace, "src", "nested"), { recursive: true, force: true });
      await symlink(outside, join(workspace, "src", "nested"));

      await expect(commitPatchApply(plan, { workspaceRoot: workspace })).rejects.toMatchObject({
        code: "pairmesh.proposal_path_denied"
      });
      expect(await readFile(join(outside, "c.ts"), "utf8")).toBe("export const c = 1;\n");
    });

    it("rejects create when parent swapped to external symlink", async () => {
      const { workspace } = await harness();
      const outside = await mkdtemp(join(tmpdir(), "pairmesh-r22-3-create-out-"));
      const plan = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: createDiff("src/nested/new.ts", "export const n = 1;\n"),
        allowedPaths: ["src/nested/new.ts"]
      });
      await rm(join(workspace, "src", "nested"), { recursive: true, force: true });
      await symlink(outside, join(workspace, "src", "nested"));
      await expect(commitPatchApply(plan, { workspaceRoot: workspace })).rejects.toMatchObject({
        code: "pairmesh.proposal_path_denied"
      });
    });

    it("rejects delete when ancestor swapped to external symlink", async () => {
      const { workspace } = await harness();
      const outside = await mkdtemp(join(tmpdir(), "pairmesh-r22-3-del-out-"));
      await writeFile(join(outside, "c.ts"), "export const c = 1;\n", "utf8");
      const plan = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: deleteDiff("src/nested/c.ts", "export const c = 1;\n"),
        allowedPaths: ["src/nested/c.ts"]
      });
      await rm(join(workspace, "src", "nested"), { recursive: true, force: true });
      await symlink(outside, join(workspace, "src", "nested"));
      await expect(commitPatchApply(plan, { workspaceRoot: workspace })).rejects.toMatchObject({
        code: "pairmesh.proposal_path_denied"
      });
      expect(await readFile(join(outside, "c.ts"), "utf8")).toBe("export const c = 1;\n");
    });

    it("rejects rename when source or dest ancestor swapped external", async () => {
      const { workspace } = await harness();
      const outside = await mkdtemp(join(tmpdir(), "pairmesh-r22-3-ren-out-"));
      await writeFile(join(outside, "old.ts"), "export const old = 1;\n", "utf8");

      const planSrc = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: renameDiff("src/old.ts", "src/nested/renamed.ts"),
        allowedPaths: ["src/old.ts", "src/nested/renamed.ts"]
      });
      // Swap dest parent
      await rm(join(workspace, "src", "nested"), { recursive: true, force: true });
      await symlink(outside, join(workspace, "src", "nested"));
      await expect(commitPatchApply(planSrc, { workspaceRoot: workspace })).rejects.toMatchObject({
        code: "pairmesh.proposal_path_denied"
      });

      // Fresh plan; swap source parent via replacing src with external (extreme)
      await mkdir(join(workspace, "src2"), { recursive: true });
      await writeFile(join(workspace, "src2", "old.ts"), "export const old = 1;\n", "utf8");
      await mkdir(join(workspace, "dst"), { recursive: true });
      const plan2 = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: renameDiff("src2/old.ts", "dst/new.ts"),
        allowedPaths: ["src2/old.ts", "dst/new.ts"]
      });
      await rm(join(workspace, "src2"), { recursive: true, force: true });
      await symlink(outside, join(workspace, "src2"));
      await expect(commitPatchApply(plan2, { workspaceRoot: workspace })).rejects.toMatchObject({
        code: "pairmesh.proposal_path_denied"
      });
    });

    it("allows internal symlink that remains inside workspace", async () => {
      const { workspace } = await harness();
      await mkdir(join(workspace, "real"), { recursive: true });
      await writeFile(join(workspace, "real", "f.ts"), "export const f = 1;\n", "utf8");
      await symlink(join(workspace, "real"), join(workspace, "alias"));
      const plan = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: modifyDiff("alias/f.ts", "export const f = 1;", "export const f = 2;"),
        allowedPaths: ["alias/f.ts"]
      });
      const result = await commitPatchApply(plan, { workspaceRoot: workspace });
      expect(result.partial).toBe(false);
      expect(await readFile(join(workspace, "real", "f.ts"), "utf8")).toContain("f = 2");
    });
  });

  describe("journal applying fail-closed", () => {
    it("crash during applying → unknown_outcome; restart does not re-apply", async () => {
      const { service, workspace, stateDir } = await harness();
      let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
      const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d301");
      const created = await createProposalArtifact(service, state, {
        actionId,
        summary: "modify a",
        unifiedDiff: modifyDiff("src/a.ts", "export const a = 1;", "export const a = 9;"),
        affectedPaths: ["src/a.ts"]
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
      service.repositoryEditExecutor!.setFaultMode("after_journal_applying");
      const unknown = await service.approveAction(pending.state, {
        actionId,
        decision: "allow-once"
      });
      expect(unknown.execution.status).toBe("unknown_outcome");
      expect(unknown.execution.result?.summary).toMatch(/cannot prove/i);
      expect(await readFile(join(workspace, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");

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
      void stateDir;
    });

    it("seeded applying journal on executing reconciles to unknown without second apply", async () => {
      const { service, stateDir } = await harness();
      let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
      const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d302");
      const created = await createProposalArtifact(service, state, {
        actionId,
        summary: "modify b",
        unifiedDiff: modifyDiff("src/b.ts", "export const b = 1;", "export const b = 9;"),
        affectedPaths: ["src/b.ts"]
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

      await writeMutationJournal(join(stateDir, "actions"), {
        actionId,
        phase: "applying",
        workspaceRoot: pending.state.localParticipant ? "" : "",
        paths: ["src/b.ts"],
        appliedPaths: [],
        updatedAt: new Date().toISOString()
      });
      const executing = {
        ...pending.execution,
        status: "executing" as const,
        executorInvocationCount: 1
      };
      const withExecuting = {
        ...pending.state,
        actionExecutions: [executing]
      };
      const reconciled = await service.requestAction(withExecuting, {
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
      expect(reconciled.execution.status).toBe("unknown_outcome");
      expect(service.repositoryEditExecutor?.applyInvocationCount ?? 0).toBe(0);
    });

    it("multi-file partial mutation remains no retry", async () => {
      const { service, workspace } = await harness();
      let state = grantEdit(baseState(kelvinId, [paulId]), paulId);
      const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d303");
      const multi = [
        modifyDiff("src/a.ts", "export const a = 1;", "export const a = 2;"),
        modifyDiff("src/b.ts", "export const b = 1;", "export const b = 2;")
      ].join("");
      const created = await createProposalArtifact(service, state, {
        actionId,
        summary: "two files",
        unifiedDiff: multi,
        affectedPaths: ["src/a.ts", "src/b.ts"]
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
      service.repositoryEditExecutor!.setFaultMode("after_first_write");
      const partial = await service.approveAction(pending.state, {
        actionId,
        decision: "allow-once"
      });
      expect(partial.execution.status).toBe("partially_completed");
      expect(await readFile(join(workspace, "src/a.ts"), "utf8")).toContain("a = 2");
      expect(await readFile(join(workspace, "src/b.ts"), "utf8")).toContain("b = 1");

      service.repositoryEditExecutor!.setFaultMode("none");
      const retry = await service.requestAction(partial.state, {
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
      expect(retry.execution.status).toBe("partially_completed");
      expect(service.repositoryEditExecutor?.applyInvocationCount).toBe(1);
      expect(await readFile(join(workspace, "src/b.ts"), "utf8")).toContain("b = 1");
    });
  });

  describe("normal ops + authority", () => {
    it("create/modify/delete/rename and multi-file apply still work", async () => {
      const { workspace } = await harness();
      const createPlan = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: createDiff("src/new.ts", "export const n = 1;\n"),
        allowedPaths: ["src/new.ts"]
      });
      await commitPatchApply(createPlan, { workspaceRoot: workspace });
      expect(await readFile(join(workspace, "src/new.ts"), "utf8")).toContain("n = 1");

      const mod = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: modifyDiff("src/a.ts", "export const a = 1;", "export const a = 3;"),
        allowedPaths: ["src/a.ts"]
      });
      await commitPatchApply(mod, { workspaceRoot: workspace });

      const del = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: deleteDiff("src/gone.ts", "export const gone = 1;\n"),
        allowedPaths: ["src/gone.ts"]
      });
      await commitPatchApply(del, { workspaceRoot: workspace });

      const ren = await preparePatchApply({
        workspaceRoot: workspace,
        unifiedDiff: renameDiff("src/old.ts", "src/renamed.ts"),
        allowedPaths: ["src/old.ts", "src/renamed.ts"]
      });
      await commitPatchApply(ren, { workspaceRoot: workspace });
      expect(await readFile(join(workspace, "src/renamed.ts"), "utf8")).toContain("old = 1");
    });

    it("authority: allow_session forbidden; grantable list intact", () => {
      expect(PAIRMESH_GRANTABLE_CAPABILITIES).toContain("repository.edit");
      expect(isAllowSessionForbidden("repository.edit", "allow_session")).toBe(true);
      const state = baseState(kelvinId, [paulId]);
      expect(() => setGrantPolicy(state, paulId, "repository.edit", "allow_session")).toThrow(
        /allow_session/
      );
    });
  });
});
