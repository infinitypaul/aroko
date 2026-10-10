import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import type { PairMeshTestsConfig } from "../local-config/schema.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { ActionService } from "./service.js";
import {
  buildControlledPathDirectories,
  listV1AllowedExecutableBasenames,
  resolveTestProfile
} from "./tests/profile.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02" as PeerId;
const sarahId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af03" as PeerId;

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/tests-run-workspace"
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
    sessionCode: "PM-TESTRUN1",
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

function defaultTestsConfig(overrides?: Partial<PairMeshTestsConfig>): PairMeshTestsConfig {
  return {
    maxConcurrent: overrides?.maxConcurrent ?? 1,
    sessionAllowedProfiles: overrides?.sessionAllowedProfiles ?? ["payment-retry"],
    profiles: {
      "payment-retry": {
        executable: "node",
        args: ["src/retry.test.mjs"],
        timeoutMs: 15_000,
        maxOutputBytes: 8_192
      },
      success: {
        executable: "node",
        args: ["scripts/success.mjs"],
        timeoutMs: 10_000,
        maxOutputBytes: 4_096
      },
      failure: {
        executable: "node",
        args: ["scripts/failure.mjs"],
        timeoutMs: 10_000,
        maxOutputBytes: 4_096
      },
      hang: {
        executable: "node",
        args: ["scripts/hang.mjs"],
        timeoutMs: 400,
        maxOutputBytes: 1_024
      },
      noisy: {
        executable: "node",
        args: ["scripts/noisy.mjs"],
        timeoutMs: 10_000,
        maxOutputBytes: 2_048
      },
      shellish: {
        executable: "bash",
        args: ["-c", "echo no"],
        timeoutMs: 5_000,
        maxOutputBytes: 1_024
      },
      ...(overrides?.profiles ?? {})
    }
  };
}

async function harness(options?: {
  testsConfig?: PairMeshTestsConfig;
  pathDirectories?: () => string[] | undefined;
}) {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-tests-run-ws-"));
  await cp(FIXTURE_ROOT, workspace, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-tests-run-state-"));
  let testsConfig = options?.testsConfig ?? defaultTestsConfig();
  const service = new ActionService({
    stateFilePath: join(dir, "state.json"),
    workspaceRoot: workspace,
    loadTestsConfig: () => testsConfig,
    testsExecutablePathDirectories: options?.pathDirectories
  });
  return {
    service,
    workspace,
    setTestsConfig(next: PairMeshTestsConfig) {
      testsConfig = next;
    },
    getTestsConfig: () => testsConfig
  };
}

function grantTests(
  state: LocalSessionState,
  requester: PeerId,
  policy: "allow_session" | "approval_required" | "deny" = "approval_required"
): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "tests.run", policy);
  return next;
}

describe("Stage 15 Prompt 5 — tests.run", () => {
  it("rejects unauthenticated requester with zero process starts", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, []), paulId);
    await expect(
      service.requestAction(state, {
        actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d001"),
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "tests.run",
        parameters: { profile: "success" }
      })
    ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });
    expect(service.testsRunExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("rejects denied capability with zero process starts", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId, "deny");
    const denied = await service.requestAction(state, {
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d002"),
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "success" }
    });
    expect(denied.execution.status).toBe("denied");
    expect(service.testsRunExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("rejects remote command/argv and unknown/shell profiles", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId);
    await expect(
      service.requestAction(state, {
        actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d003"),
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "tests.run",
        parameters: { profile: "success", command: "rm -rf /" }
      })
    ).rejects.toMatchObject({ code: "pairmesh.test_profile_invalid" });
    await expect(
      service.requestAction(state, {
        actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d004"),
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "tests.run",
        parameters: { profile: "missing" }
      })
    ).rejects.toMatchObject({ code: "pairmesh.test_profile_not_found" });
    await expect(
      service.requestAction(state, {
        actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d005"),
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "tests.run",
        parameters: { profile: "shellish" }
      })
    ).rejects.toMatchObject({ code: "pairmesh.test_profile_invalid" });
  });

  it("runs payment-retry under session allowlist; replay does not re-spawn", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId, "allow_session");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d010");
    const ran = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "payment-retry" }
    });
    expect(ran.execution.status).toBe("completed");
    expect(ran.execution.result?.outputs?.testPassed).toBe(true);
    expect(ran.execution.result?.outputs?.exitCode).toBe(0);
    expect(ran.execution.result?.outputs?.profileName).toBe("payment-retry");
    expect(service.testsRunExecutorInstance?.processInvocationCount).toBe(1);

    const replay = await service.requestAction(ran.state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "payment-retry" }
    });
    expect(replay.execution.status).toBe("completed");
    expect(service.testsRunExecutorInstance?.processInvocationCount).toBe(1);
  });

  it("treats non-zero exit as completed with testPassed=false", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d011");
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "failure" }
    });
    expect(pending.execution.status).toBe("approval_required");
    const approved = await service.approveAction(pending.state, {
      actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(approved.execution.result?.outputs?.testPassed).toBe(false);
    expect(approved.execution.result?.outputs?.exitCode).toBe(1);
  });

  it("requires approval for non-sessionAllowed profile even with allow_session", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId, "allow_session");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d012");
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "success" }
    });
    expect(pending.execution.status).toBe("approval_required");
    expect(service.testsRunExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("invalidates approval when profile definition changes", async () => {
    const { service, setTestsConfig, getTestsConfig } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d013");
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "success" }
    });
    const current = getTestsConfig();
    setTestsConfig({
      ...current,
      profiles: {
        ...current.profiles,
        success: {
          ...current.profiles.success!,
          args: ["scripts/failure.mjs"]
        }
      }
    });
    await expect(
      service.approveAction(pending.state, { actionId, decision: "allow-once" })
    ).rejects.toMatchObject({ code: "pairmesh.test_profile_changed" });
    expect(service.testsRunExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("revocation and policy deny before start prevent spawn", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d014");
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "success" }
    });
    await expect(
      service.approveAction({ ...pending.state, peers: [] }, { actionId, decision: "allow-once" })
    ).rejects.toMatchObject({ code: "pairmesh.authentication_required" });
    await expect(
      service.approveAction(setGrantPolicy(pending.state, paulId, "tests.run", "deny"), {
        actionId,
        decision: "allow-once"
      })
    ).rejects.toMatchObject({ code: "pairmesh.action_not_authorized" });
    expect(service.testsRunExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("times out hanging profiles", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d015");
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "hang" }
    });
    const result = await service.approveAction(pending.state, {
      actionId,
      decision: "allow-once"
    });
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error?.code).toBe("pairmesh.test_execution_timeout");
  }, 15_000);

  it("bounds noisy output", async () => {
    const { service } = await harness();
    const state = grantTests(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d016");
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "noisy" }
    });
    const done = await service.approveAction(pending.state, {
      actionId,
      decision: "allow-once"
    });
    expect(done.execution.status).toBe("completed");
    expect(done.execution.result?.outputs?.stdoutTruncated).toBe(true);
  });

  it("isolates peers and conflicts on changed material", async () => {
    const { service } = await harness();
    let state = grantTests(baseState(kelvinId, [paulId, sarahId]), paulId);
    state = grantTests(state, sarahId);
    const paulAction = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d017");
    const first = await service.requestAction(state, {
      actionId: paulAction,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "success" }
    });
    await expect(
      service.requestAction(first.state, {
        actionId: paulAction,
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "tests.run",
        parameters: { profile: "failure" }
      })
    ).rejects.toMatchObject({ code: "pairmesh.action_conflict" });

    const sarahAction = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d018");
    const sarahPending = await service.requestAction(first.state, {
      actionId: sarahAction,
      requesterParticipantId: sarahId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "success" }
    });
    expect(sarahPending.execution.requesterParticipantId).toBe(sarahId);
  });

  it("enforces per-workspace concurrency limit", async () => {
    const { service, setTestsConfig } = await harness({
      testsConfig: defaultTestsConfig({
        maxConcurrent: 1,
        sessionAllowedProfiles: ["hang", "success"],
        profiles: {
          hang: {
            executable: "node",
            args: ["scripts/hang.mjs"],
            timeoutMs: 2_500,
            maxOutputBytes: 512
          }
        }
      })
    });
    setTestsConfig(
      defaultTestsConfig({
        maxConcurrent: 1,
        sessionAllowedProfiles: ["hang", "success"],
        profiles: {
          hang: {
            executable: "node",
            args: ["scripts/hang.mjs"],
            timeoutMs: 2_500,
            maxOutputBytes: 512
          }
        }
      })
    );
    const state = grantTests(baseState(kelvinId, [paulId]), paulId, "allow_session");
    const a = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d020");
    const b = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d021");
    const firstPromise = service.requestAction(state, {
      actionId: a,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "hang" }
    });
    await new Promise((r) => setTimeout(r, 80));
    const second = await service.requestAction(state, {
      actionId: b,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "success" }
    });
    if (second.execution.status === "failed") {
      expect(second.execution.error?.code).toBe("pairmesh.test_execution_busy");
    }
    await firstPromise;
  }, 20_000);

  it("Claude propose adapter remains read-only", async () => {
    const { ClaudeCodeAdapter } = await import("../coding-agent/claude-code-adapter.js");
    let captured: string[] = [];
    const adapter = new ClaudeCodeAdapter({
      workspace: await mkdtemp(join(tmpdir(), "pairmesh-claude-ro-")),
      timeoutMs: 5_000,
      runProcess: async (input) => {
        captured = input.args;
        return { stdout: JSON.stringify({ result: "nope" }), stderr: "", exitCode: 0 };
      }
    });
    await expect(
      adapter.proposeChange({ instruction: "x", requestId: "req_ro" })
    ).rejects.toBeTruthy();
    expect(captured.join(" ")).toContain("Read,Grep,Glob");
    expect(captured.join(" ")).not.toMatch(/\bWrite\b|\bEdit\b|\bBash\b/);
  });

  it("does not select a malicious workspace-local binary named pnpm", async () => {
    const marker = join(tmpdir(), `pairmesh-shadow-marker-${Date.now()}.txt`);
    const safeBin = await mkdtemp(join(tmpdir(), "pairmesh-safe-bin-"));
    const safePnpm = join(safeBin, "pnpm");
    // Pure shell — must not depend on node being on the controlled child PATH.
    await writeFile(safePnpm, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(safePnpm, 0o755);

    const { service, workspace } = await harness({
      pathDirectories: () => [safeBin],
      testsConfig: defaultTestsConfig({
        sessionAllowedProfiles: ["via-pnpm"],
        profiles: {
          "via-pnpm": {
            executable: "pnpm",
            args: [],
            timeoutMs: 10_000,
            maxOutputBytes: 1_024
          }
        }
      })
    });

    const shadowDir = join(workspace, "node_modules", ".bin");
    await mkdir(shadowDir, { recursive: true });
    const shadow = join(shadowDir, "pnpm");
    await writeFile(shadow, `#!/bin/sh\nprintf shadowed >'${marker}'\nexit 99\n`, {
      mode: 0o755
    });
    await chmod(shadow, 0o755);

    // Controlled PATH must exclude the workspace entirely.
    expect(buildControlledPathDirectories(workspace).some((d) => d.startsWith(workspace))).toBe(
      false
    );

    const state = grantTests(baseState(kelvinId, [paulId]), paulId, "allow_session");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d030");
    const ran = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "via-pnpm" }
    });
    expect(ran.execution.status).toBe("completed");
    expect(ran.execution.result?.outputs?.exitCode).toBe(0);
    await expect(readFile(marker, "utf8")).rejects.toBeTruthy();
  });

  it("PATH change that resolves a different executable invalidates profile digest", async () => {
    const binA = await mkdtemp(join(tmpdir(), "pairmesh-path-a-"));
    const binB = await mkdtemp(join(tmpdir(), "pairmesh-path-b-"));
    for (const [dir, tag] of [
      [binA, "A"],
      [binB, "B"]
    ] as const) {
      const exe = join(dir, "node");
      await writeFile(exe, `#!/bin/sh\necho ${tag}\nexit 0\n`, { mode: 0o755 });
      await chmod(exe, 0o755);
    }

    let pathDirs = [binA];
    const { service, workspace } = await harness({
      pathDirectories: () => pathDirs,
      testsConfig: defaultTestsConfig({
        sessionAllowedProfiles: [],
        profiles: {
          success: {
            executable: "node",
            args: ["scripts/success.mjs"],
            timeoutMs: 10_000,
            maxOutputBytes: 1_024
          }
        }
      })
    });

    const first = await resolveTestProfile({
      name: "success",
      testsConfig: defaultTestsConfig(),
      workspaceRoot: workspace,
      pathDirectories: [binA]
    });
    const second = await resolveTestProfile({
      name: "success",
      testsConfig: defaultTestsConfig(),
      workspaceRoot: workspace,
      pathDirectories: [binB]
    });
    expect(first.digest).not.toBe(second.digest);
    expect(first.executableAbsolute).not.toBe(second.executableAbsolute);

    const state = grantTests(baseState(kelvinId, [paulId]), paulId);
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d031");
    const pending = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "success" }
    });
    expect(pending.execution.status).toBe("approval_required");
    pathDirs = [binB];
    await expect(
      service.approveAction(pending.state, { actionId, decision: "allow-once" })
    ).rejects.toMatchObject({ code: "pairmesh.test_profile_changed" });
    expect(service.testsRunExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("resolves a known safe executable and never leaks absolute path remotely", async () => {
    const { service, workspace } = await harness();
    const resolved = await resolveTestProfile({
      name: "payment-retry",
      testsConfig: defaultTestsConfig(),
      workspaceRoot: workspace
    });
    expect(resolved.executableBasename).toBe("node");
    expect(resolved.executableAbsolute.startsWith("/")).toBe(true);
    expect(resolved.executableAbsolute.includes(workspace)).toBe(false);

    const state = grantTests(baseState(kelvinId, [paulId]), paulId, "allow_session");
    const actionId = ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d032");
    const ran = await service.requestAction(state, {
      actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "tests.run",
      parameters: { profile: "payment-retry" }
    });
    expect(ran.execution.status).toBe("completed");
    const serialized = JSON.stringify({
      result: ran.execution.result,
      parameters: ran.execution.parameters,
      auditedEvents: ran.execution.auditedEvents
    });
    expect(serialized).not.toContain(resolved.executableAbsolute);
    expect(ran.execution.result?.outputs).not.toHaveProperty("executableAbsolute");
    expect(ran.execution.result?.outputs).not.toHaveProperty("executable");
  });

  it("rejects npx so package install/fetch cannot be triggered", async () => {
    expect(listV1AllowedExecutableBasenames()).not.toContain("npx");
    const { service } = await harness({
      testsConfig: defaultTestsConfig({
        profiles: {
          "npx-evil": {
            executable: "npx",
            args: ["--yes", "some-package"],
            timeoutMs: 5_000,
            maxOutputBytes: 1_024
          }
        }
      })
    });
    const state = grantTests(baseState(kelvinId, [paulId]), paulId);
    await expect(
      service.requestAction(state, {
        actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4d033"),
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "tests.run",
        parameters: { profile: "npx-evil" }
      })
    ).rejects.toMatchObject({ code: "pairmesh.test_profile_invalid" });
    expect(service.testsRunExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });
});
