import { describe, expect, it } from "vitest";
import {
  PAIRMESH_FUTURE_CAPABILITIES,
  PAIRMESH_GRANTABLE_CAPABILITIES,
  type PeerId
} from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import type { PairMeshProcessExecutionConfig } from "../local-config/schema.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { ActionService } from "./service.js";
import {
  assertRemoteProcessExecuteParameters,
  isShellInterpreterBasename
} from "./process/resolve.js";
import { formatProcessCommandDisplay } from "./process/artifact.js";
import { isAllowSessionForbidden } from "../../control-web/people-present.js";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af11" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af12" as PeerId;

function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

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
    sessionCode: "PM-R4M2",
    session: {
      id: "ses_r4m2",
      createdBy: "dev_r4m2",
      createdAt: "2026-09-04T12:00:00.000Z",
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

function grantProcess(
  state: LocalSessionState,
  requester: PeerId,
  policy: "approval_required" | "deny" = "approval_required"
): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "process.execute", policy);
  return next;
}

async function harness() {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r4m2-"));
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-r4m2-state-"));
  let processConfig: PairMeshProcessExecutionConfig = {
    maxConcurrent: 1,
    defaultTimeoutMs: 15_000,
    maxTimeoutMs: 60_000,
    maxOutputBytes: 8_192,
    env: {}
  };
  const pathDirectories = () => {
    const dirs = process.env.PATH?.split(":") ?? [];
    return dirs.filter((d) => d && !d.startsWith(workspace));
  };
  const service = new ActionService({
    stateFilePath: join(dir, "state.json"),
    workspaceRoot: workspace,
    loadProcessConfig: async () => processConfig,
    processExecutablePathDirectories: pathDirectories
  });
  return {
    service,
    workspace,
    setProcessConfig(next: PairMeshProcessExecutionConfig) {
      processConfig = next;
    }
  };
}

describe("R4-M2 — non-shell interpreter argument handling", () => {
  it("allows python3 -c as structured argv; refuses shell executables by identity", () => {
    expect(() =>
      assertRemoteProcessExecuteParameters({
        executable: "python3",
        args: ["-c", "print('R4_PYTHON_OK')"]
      })
    ).not.toThrow();
    expect(() =>
      assertRemoteProcessExecuteParameters({
        executable: "node",
        args: ["-c", "unused"]
      })
    ).not.toThrow();

    for (const shell of ["sh", "bash", "zsh", "dash", "cmd", "powershell", "pwsh"]) {
      expect(isShellInterpreterBasename(shell)).toBe(true);
      expect(() =>
        assertRemoteProcessExecuteParameters({
          executable: shell,
          args: ["-c", "echo SHOULD_NOT_RUN"]
        })
      ).toThrow(/Shell hosts/);
      expect(() =>
        assertRemoteProcessExecuteParameters({
          executable: shell,
          args: ["--version"]
        })
      ).toThrow(/Shell hosts/);
    }
  });

  it("keeps metacharacters as literal argv for non-shell display/authority", () => {
    const args = ["&&", "|", ">", "$(echo x)"];
    const parsed = assertRemoteProcessExecuteParameters({
      executable: "node",
      args: ["-e", "console.log(process.argv.slice(1))", ...args]
    });
    expect(parsed.args.slice(2)).toEqual(args);
    const display = formatProcessCommandDisplay("node", parsed.args);
    expect(display).toContain("&&");
    expect(display).toContain("|");
  });

  it("rejects requester env injection and preserves grantable/shell invariants", () => {
    expect(() =>
      assertRemoteProcessExecuteParameters({
        executable: "python3",
        args: ["-c", "print(1)"],
        env: { SECRET: "x" }
      })
    ).toThrow(/env/);
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toHaveLength(6);
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).toContain("process.execute");
    expect(PAIRMESH_GRANTABLE_CAPABILITIES).not.toContain("shell.execute");
    expect(PAIRMESH_FUTURE_CAPABILITIES).toContain("shell.execute");
    expect(isAllowSessionForbidden("process.execute", "allow_session")).toBe(true);
  });

  it("python3 -c Approve once: no spawn before approval, stdout, exit once", async () => {
    if (!which("python3")) {
      return; // environment without python3 — parameter-level tests still cover allow
    }
    const { service } = await harness();
    let state = grantProcess(baseState(kelvinId, [paulId]), paulId, "approval_required");
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: {
        executable: "python3",
        args: ["-c", "print('R4_PYTHON_OK')"]
      }
    });
    expect(begun.execution.status).toBe("approval_required");
    expect(begun.execution.parameters?.executable).toBe("python3");
    expect(begun.execution.parameters?.args).toEqual(["-c", "print('R4_PYTHON_OK')"]);
    expect(begun.execution.parameters?.commandDisplay).toContain("python3");
    expect(service.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);

    const approved = await service.approveAction(begun.state, {
      actionId: begun.execution.actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(approved.execution.result?.outputs?.stdout).toContain("R4_PYTHON_OK");
    expect(approved.execution.result?.outputs?.exitCode).toBe(0);
    expect(service.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
  });

  it("python3 -c nonzero exit remains truthful", async () => {
    if (!which("python3")) return;
    const { service } = await harness();
    let state = grantProcess(baseState(kelvinId, [paulId]), paulId, "approval_required");
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: {
        executable: "python3",
        args: ["-c", "raise SystemExit(7)"]
      }
    });
    const approved = await service.approveAction(begun.state, {
      actionId: begun.execution.actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("completed");
    expect(approved.execution.result?.outputs?.exitCode).toBe(7);
    expect(service.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
  });

  it("python3 -c timeout remains truthful", async () => {
    if (!which("python3")) return;
    const { service } = await harness();
    let state = grantProcess(baseState(kelvinId, [paulId]), paulId, "approval_required");
    const begun = await service.beginRequestAction(state, {
      requesterParticipantId: paulId,
      targetParticipantId: kelvinId,
      actionType: "process.execute",
      parameters: {
        executable: "python3",
        args: ["-c", "import time; time.sleep(30)"],
        timeoutMs: 2000
      }
    });
    const approved = await service.approveAction(begun.state, {
      actionId: begun.execution.actionId,
      decision: "allow-once"
    });
    expect(approved.execution.status).toBe("failed");
    expect(approved.execution.result?.outputs?.timedOut).toBe(true);
    expect(approved.execution.result?.error?.code).toBe("pairmesh.process_execution_timeout");
    expect(service.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
  });

  it("does not spawn prohibited shell even with benign args when resolved", async () => {
    if (!which("sh")) return;
    const { service } = await harness();
    const state = grantProcess(baseState(kelvinId, [paulId]), paulId, "approval_required");
    await expect(
      service.beginRequestAction(state, {
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "process.execute",
        parameters: { executable: "sh", args: ["--version"] }
      })
    ).rejects.toMatchObject({ code: "pairmesh.process_executable_invalid" });
    expect(service.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
  });
});
