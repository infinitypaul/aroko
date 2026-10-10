import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAIRMESH_FUTURE_CAPABILITIES,
  PAIRMESH_GRANTABLE_CAPABILITIES,
  PAIRMESH_CAPABILITY_REGISTRY,
  ActionIdSchema,
  type PeerId
} from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import type { PairMeshProcessExecutionConfig } from "../local-config/schema.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { ActionService } from "./service.js";
import { buildChildEnvironment } from "./tests/profile.js";
import {
  assertRemoteProcessExecuteParameters,
  computeExecutableIdentity,
  resolveProcessExecutable
} from "./process/resolve.js";
import { sanitizeProcessOutput } from "./process/runner.js";
import { writeProcessSpawnJournal } from "./process/spawn-journal.js";
import { formatProcessCommandDisplay } from "./process/artifact.js";
import {
  policyOptionsForCapability,
  isAllowSessionForbidden
} from "../../control-web/people-present.js";

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
    sessionCode: "PM-R4PROC1",
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

function defaultProcessConfig(
  overrides?: Partial<PairMeshProcessExecutionConfig>
): PairMeshProcessExecutionConfig {
  return {
    maxConcurrent: overrides?.maxConcurrent ?? 1,
    defaultTimeoutMs: overrides?.defaultTimeoutMs ?? 15_000,
    maxTimeoutMs: overrides?.maxTimeoutMs ?? 60_000,
    maxOutputBytes: overrides?.maxOutputBytes ?? 8_192,
    env: overrides?.env ?? {}
  };
}

async function harness(options?: {
  processConfig?: PairMeshProcessExecutionConfig;
  pathDirectories?: () => string[] | undefined;
}) {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r4-ws-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "hello.txt"), "hello\n", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-r4-state-"));
  let processConfig = options?.processConfig ?? defaultProcessConfig();
  const service = new ActionService({
    stateFilePath: join(dir, "state.json"),
    workspaceRoot: workspace,
    loadProcessConfig: () => processConfig,
    processExecutablePathDirectories: options?.pathDirectories
  });
  return {
    service,
    workspace,
    stateDir: dir,
    setProcessConfig(next: PairMeshProcessExecutionConfig) {
      processConfig = next;
    }
  };
}

function grantProcess(
  state: LocalSessionState,
  requester: PeerId,
  policy: "allow_session" | "approval_required" | "deny" = "approval_required"
): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "process.execute", policy);
  return next;
}

describe("R4 — process.execute", () => {
  it("registers process.execute as 6th grantable capability; shell.execute not grantable", () => {
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toHaveLength(6);
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toContain("process.execute");
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).not.toContain("shell.execute");
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).not.toContain("repository.shell");
    expect(PAIRMESH_FUTURE_CAPABILITIES).toContain("shell.execute");
    expect(PAIRMESH_FUTURE_CAPABILITIES).not.toContain("repository.shell");
    expect(
      PAIRMESH_CAPABILITY_REGISTRY.find((e) => e.id === "process.execute")?.defaultPolicy
    ).toBe("deny");
  });

  it("rejects allow_session for process.execute", () => {
    const state = baseState(kelvinId, [paulId]);
    expect(() => setGrantPolicy(state, paulId, "process.execute", "allow_session")).toThrow(
      /allow_session/
    );
    expect(policyOptionsForCapability("process.execute").map((o) => o.policy)).toEqual([
      "approval_required",
      "deny"
    ]);
    expect(isAllowSessionForbidden("process.execute", "allow_session")).toBe(true);
  });

  it("rejects command strings, env injection, absolute executables, and shells", () => {
    expect(() => assertRemoteProcessExecuteParameters({ command: "npm run build" })).toThrow(
      /must not supply 'command'/
    );
    expect(() =>
      assertRemoteProcessExecuteParameters({ executable: "npm", env: { A: "1" } })
    ).toThrow(/env/);
    expect(() => assertRemoteProcessExecuteParameters({ executable: "/usr/bin/npm" })).toThrow(
      /basename/
    );
    expect(() =>
      assertRemoteProcessExecuteParameters({ executable: "./node_modules/.bin/tool" })
    ).toThrow(/basename/);
    expect(() => assertRemoteProcessExecuteParameters({ executable: "bash" })).toThrow(
      /Shell hosts/
    );
    expect(() =>
      assertRemoteProcessExecuteParameters({ executable: "sh", args: ["-c", "echo x"] })
    ).toThrow(/Shell hosts/);
    // R4-M2: non-shell executables may use `-c` as ordinary argv.
    expect(() =>
      assertRemoteProcessExecuteParameters({
        executable: "python3",
        args: ["-c", "print('ok')"]
      })
    ).not.toThrow();
    expect(() =>
      assertRemoteProcessExecuteParameters({ executable: "node", args: ["-c", "1+1"] })
    ).not.toThrow();
  });

  it("treats shell metacharacters as literal argv (display only reconstructs)", () => {
    const display = formatProcessCommandDisplay("echo", ["hello && rm -rf /"]);
    expect(display).toContain("hello && rm -rf /");
    expect(display.split(" ").length).toBeGreaterThan(2);
  });

  it("sanitizes ANSI and does not inherit secret-shaped env", () => {
    expect(sanitizeProcessOutput("\u001b[31mred\u001b[0m")).toBe("red");
    const env = buildChildEnvironment({}, { workspaceRoot: "/tmp/ws" });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.PATH).toBeTruthy();
  });

  it("denies by default with zero process starts", async () => {
    const { service } = await harness();
    const state = grantProcess(baseState(kelvinId, [paulId]), paulId, "deny");
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: { executable: "node", args: ["-e", "console.log(1)"] }
    });
    expect(begun.execution.status).toBe("denied");
    expect(service.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("fail-closes allow-once when owner-safe process projection is missing", async () => {
    const { service } = await harness();
    let state = grantProcess(baseState(kelvinId, [paulId]), paulId, "approval_required");
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: { executable: "node", args: ["-e", "console.log(1)"] }
    });
    expect(begun.execution.status).toBe("approval_required");
    // Corrupt local parameters to simulate opaque approval card (artifact still present).
    const opaque = {
      ...begun.execution,
      parameters: {}
    };
    state = {
      ...begun.state,
      actionExecutions: [opaque]
    };
    await expect(
      service.approveAction(state, {
        actionId: begun.execution.actionId,
        decision: "allow-once"
      })
    ).rejects.toMatchObject({
      code: "pairmesh.action_not_authorized",
      message: expect.stringMatching(/Unable to display command details/i)
    });
    expect(service.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);

    // Deny remains available.
    const denied = await service.approveAction(state, {
      actionId: begun.execution.actionId,
      decision: "deny"
    });
    expect(denied.execution.status).toBe("denied");
  });

  it("requires Approve once, runs structured node once, returns exit code", async () => {
    const { service, workspace } = await harness({
      pathDirectories: () => {
        const dirs = process.env.PATH?.split(":") ?? [];
        return dirs.filter((d) => d && !d.startsWith(workspace));
      }
    });
    let state = grantProcess(baseState(kelvinId, [paulId]), paulId, "approval_required");
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: {
        executable: "node",
        args: ["-e", "process.stdout.write('ok'); process.exit(0)"]
      }
    });
    expect(begun.execution.status).toBe("approval_required");
    expect(begun.execution.artifactRefs?.[0]?.artifactType).toBe("process_execution");
    expect(begun.execution.parameters?.executable).toBe("node");
    expect(JSON.stringify(begun.execution)).not.toMatch(/\/usr\/|\/bin\/node|\/opt\//);

    await expect(
      service.approveAction(begun.state, {
        actionId: begun.execution.actionId,
        decision: "allow-session"
      })
    ).rejects.toMatchObject({ code: "pairmesh.capability_not_allowed" });

    const approved = await service.approveAction(begun.state, {
      actionId: begun.execution.actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(approved.execution.result?.outputs?.stdout).toBe("ok");
    expect(approved.execution.result?.outputs?.exitCode).toBe(0);
    expect(service.processExecuteExecutorInstance?.processInvocationCount).toBe(1);

    const again = await service.beginRequestAction(approved.state, {
      actionId: approved.execution.actionId,
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: begun.execution.parameters
    });
    expect(again.execution.status).toBe("completed");
    expect(service.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
  });

  it("rejects workspace-local executable shadowing via controlled resolve", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r4-shadow-ws-"));
    await mkdir(join(workspace, "bin"), { recursive: true });
    const shadow = join(workspace, "bin", "tool");
    await writeFile(shadow, "#!/bin/sh\necho shadowed\n", "utf8");
    await chmod(shadow, 0o755);
    await expect(
      resolveProcessExecutable({
        executableBasename: "tool",
        workspaceRoot: workspace,
        pathDirectories: [join(workspace, "bin"), "/usr/bin", "/bin"]
      })
    ).rejects.toMatchObject({ code: "pairmesh.process_executable_invalid" });

    const { service } = await harness();
    const state = grantProcess(baseState(kelvinId, [paulId]), paulId);
    await expect(
      service.beginRequestAction(state, {
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "process.execute",
        parameters: { executable: "node", args: ["-e", "1"], cwd: "../" }
      })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/boundary_violation|proposal_path_denied/)
    });
  });

  it("refuses when executable identity changes after approval", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "pairmesh-r4-bin-"));
    const exeA = join(binDir, "tool");
    await writeFile(exeA, "#!/bin/sh\necho A\n", "utf8");
    await chmod(exeA, 0o755);

    const { service, setProcessConfig } = await harness({
      pathDirectories: () => [binDir]
    });
    let state = grantProcess(baseState(kelvinId, [paulId]), paulId);
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: { executable: "tool", args: [] }
    });
    expect(begun.execution.status).toBe("approval_required");

    await writeFile(exeA, "#!/bin/sh\necho B-replaced\n", "utf8");
    await chmod(exeA, 0o755);

    await expect(
      service.approveAction(begun.state, {
        actionId: begun.execution.actionId,
        decision: "allow-once"
      })
    ).rejects.toMatchObject({ code: "pairmesh.process_executable_changed" });
    expect(service.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
    void setProcessConfig;
  });

  it("refuses when env policy changes after approval", async () => {
    const { service, setProcessConfig } = await harness({
      pathDirectories: () => (process.env.PATH ?? "").split(":").filter(Boolean)
    });
    let state = grantProcess(baseState(kelvinId, [paulId]), paulId);
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: {
        executable: "node",
        args: ["-e", "process.exit(0)"]
      }
    });
    setProcessConfig(defaultProcessConfig({ env: { NODE_ENV: "test-changed" } }));
    await expect(
      service.approveAction(begun.state, {
        actionId: begun.execution.actionId,
        decision: "allow-once"
      })
    ).rejects.toMatchObject({ code: "pairmesh.process_env_policy_changed" });
  });

  it("does not re-spawn after spawn_committed unknown_outcome", async () => {
    const { service, stateDir } = await harness({
      pathDirectories: () => (process.env.PATH ?? "").split(":").filter(Boolean)
    });
    let state = grantProcess(baseState(kelvinId, [paulId]), paulId);
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: {
        executable: "node",
        args: ["-e", "process.exit(0)"]
      }
    });
    const actionId = begun.execution.actionId;
    // Simulate crash after spawn commitment without terminal result.
    await writeProcessSpawnJournal(join(stateDir, "actions"), {
      actionId: ActionIdSchema.parse(actionId),
      phase: "spawn_committed",
      updatedAt: new Date().toISOString()
    });
    const executing = {
      ...begun.execution,
      status: "executing" as const,
      executorInvocationCount: 1
    };
    const withExecuting = {
      ...begun.state,
      actionExecutions: [executing]
    };
    const reconciled = await service.beginRequestAction(withExecuting, {
      actionId: ActionIdSchema.parse(actionId),
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: begun.execution.parameters
    });
    expect(reconciled.execution.status).toBe("unknown_outcome");
    expect(service.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });

  it("computes identity from realpath + content hash", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "pairmesh-r4-id-"));
    const exe = join(binDir, "tool");
    await writeFile(exe, "#!/bin/sh\necho hi\n", "utf8");
    await chmod(exe, 0o755);
    const resolved = await resolveProcessExecutable({
      executableBasename: "tool",
      workspaceRoot: await mkdtemp(join(tmpdir(), "pairmesh-r4-ws2-")),
      pathDirectories: [binDir]
    });
    const again = await computeExecutableIdentity(resolved.absolutePath);
    expect(again.identity).toBe(resolved.identity);
    expect(resolved.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    const bytes = await readFile(exe);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
