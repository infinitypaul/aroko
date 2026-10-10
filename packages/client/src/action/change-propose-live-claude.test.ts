import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import { ClaudeCodeAdapter } from "../coding-agent/claude-code-adapter.js";
import { CodingAgentProposalGenerator } from "./proposal/index.js";
import { digestWorkingTree } from "./proposal/working-tree.js";
import { ActionService } from "./service.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";

const live = process.env.PAIRMESH_LIVE_CLAUDE_PROPOSE === "1";
const claudeCommand =
  process.env.PAIRMESH_CLAUDE_COMMAND?.trim() ||
  resolve(process.cwd(), ".tmp/claude-cli/node_modules/.bin/claude");
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/propose-payment-service"
);

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
    sessionCode: "PM-LIVEPROPOSE",
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

function gitPorcelain(workspace: string): string {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout : `(git unavailable)`;
}

describe.runIf(live)("Stage 15 Prompt 3 closure — live Claude Code change.propose", () => {
  it("generates a real proposal without mutating the working tree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-live-propose-"));
    await cp(fixtureRoot, workspace, { recursive: true });
    spawnSync("git", ["init"], { cwd: workspace, encoding: "utf8" });
    spawnSync("git", ["add", "."], { cwd: workspace, encoding: "utf8" });
    spawnSync(
      "git",
      [
        "-c",
        "user.email=pairmesh@example.com",
        "-c",
        "user.name=PairMesh",
        "commit",
        "-m",
        "fixture"
      ],
      { cwd: workspace, encoding: "utf8" }
    );

    const beforeDigest = await digestWorkingTree(workspace);
    const beforeGit = gitPorcelain(workspace);
    const beforeRetry = await readFile(join(workspace, "src/retry.ts"), "utf8");

    const adapter = new ClaudeCodeAdapter({
      workspace,
      timeoutMs: 180_000,
      command: claudeCommand
    });
    expect((await adapter.getAvailability()).status).toBe("available");

    const stateDir = await mkdtemp(join(tmpdir(), "pairmesh-live-propose-state-"));
    const service = new ActionService({
      stateFilePath: join(stateDir, "state.json"),
      workspaceRoot: workspace,
      proposalGenerator: new CodingAgentProposalGenerator(adapter)
    });

    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4c901");
    const instruction =
      "Propose a fix so retry reconstruction preserves the original payment reference instead of synthesizing one from customerId.";
    const started = Date.now();
    const first = await service.requestAction(grantPropose(baseState(kelvinId, [paulId]), paulId), {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: { instruction }
    });
    const elapsedMs = Date.now() - started;

    expect(first.execution.status).toBe("completed");
    const proposal = await service.getProposal(first.state, { actionId });
    expect(proposal.affectedPaths).toContain("src/retry.ts");
    expect(proposal.unifiedDiff).toMatch(/reference/i);
    expect(proposal.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const afterDigest = await digestWorkingTree(workspace);
    const afterGit = gitPorcelain(workspace);
    const afterRetry = await readFile(join(workspace, "src/retry.ts"), "utf8");
    expect(afterDigest.contentDigest).toBe(beforeDigest.contentDigest);
    expect(afterRetry).toBe(beforeRetry);
    expect(afterGit).toBe(beforeGit);

    const second = await service.requestAction(first.state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "change.propose",
      parameters: { instruction }
    });
    const again = await service.getProposal(second.state, { actionId });
    expect(again.contentHash).toBe(proposal.contentHash);

    console.log(
      JSON.stringify(
        {
          provider: "claude-code",
          actionId,
          artifactId: proposal.artifactId,
          contentHash: proposal.contentHash,
          summary: proposal.summary,
          affectedPaths: proposal.affectedPaths,
          stats: proposal.stats,
          elapsedMs,
          beforeWorkingTreeDigest: beforeDigest.contentDigest,
          afterWorkingTreeDigest: afterDigest.contentDigest,
          workingTreeUnchanged: true
        },
        null,
        2
      )
    );
  }, 240_000);
});
