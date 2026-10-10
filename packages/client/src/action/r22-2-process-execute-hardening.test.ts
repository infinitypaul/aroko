import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAIRMESH_GRANTABLE_CAPABILITIES, type PeerId } from "@pairmesh/protocol";
import { ensureDefaultGrants, setGrantPolicy } from "../auth/capabilities.js";
import { createSessionSecurity } from "../auth/session-security.js";
import type { PairMeshProcessExecutionConfig } from "../local-config/schema.js";
import { LOCAL_STATE_VERSION, type LocalSessionState } from "../session/schemas.js";
import { ActionService } from "./service.js";
import { assertRemoteProcessExecuteParameters, validateProcessCwd } from "./process/resolve.js";
import {
  assertNoShellHostInvocation,
  assertResolvedExecutableNotWindowsShellScript,
  isShellHostBasename,
  isWindowsShellScriptPath,
  resolveWrapperCommandTarget,
  SHELL_HOST_BASENAMES
} from "./process/shell-host-policy.js";
import { isAllowSessionForbidden } from "../../control-web/people-present.js";

const paulId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af21" as PeerId;
const kelvinId = "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af22" as PeerId;

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
    sessionCode: "PM-R22-2",
    session: {
      id: "ses_r22_2",
      createdBy: "dev_r22_2",
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

function grantProcess(state: LocalSessionState, requester: PeerId): LocalSessionState {
  let next = {
    ...state,
    sessionSecurity: ensureDefaultGrants(state.sessionSecurity!, requester)
  };
  next = setGrantPolicy(next, requester, "process.execute", "approval_required");
  return next;
}

async function harness() {
  const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-ws-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "hello.txt"), "hello\n", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-state-"));
  const processConfig: PairMeshProcessExecutionConfig = {
    maxConcurrent: 1,
    defaultTimeoutMs: 15_000,
    maxTimeoutMs: 60_000,
    maxOutputBytes: 8_192,
    env: {}
  };
  const service = new ActionService({
    stateFilePath: join(dir, "state.json"),
    workspaceRoot: workspace,
    loadProcessConfig: async () => processConfig,
    processExecutablePathDirectories: () =>
      (process.env.PATH ?? "").split(":").filter((d) => d && !d.startsWith(workspace))
  });
  return { service, workspace };
}

describe("R22-2 — process.execute shell-host / cwd / Windows hardening", () => {
  describe("direct shell hosts", () => {
    it("rejects bash, sh, zsh, dash, fish, cmd, powershell, pwsh", () => {
      for (const shell of [
        "bash",
        "sh",
        "zsh",
        "dash",
        "fish",
        "cmd",
        "cmd.exe",
        "powershell",
        "powershell.exe",
        "pwsh",
        "pwsh.exe"
      ]) {
        expect(isShellHostBasename(shell)).toBe(true);
        expect(SHELL_HOST_BASENAMES.has(shell.toLowerCase()) || shell.includes(".")).toBe(true);
        expect(() =>
          assertRemoteProcessExecuteParameters({
            executable: shell,
            args: ["-c", "echo no"]
          })
        ).toThrow(/Shell hosts/);
      }
    });
  });

  describe("wrapper bypass", () => {
    it("rejects env bash -c and env sh -c", () => {
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "env",
          args: ["bash", "-c", "echo pwned"]
        })
      ).toThrow(/shell host/i);
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "env",
          args: ["FOO=1", "sh", "-c", "echo pwned"]
        })
      ).toThrow(/shell host/i);
      expect(() =>
        assertRemoteProcessExecuteParameters({
          executable: "env",
          args: ["-i", "bash", "-c", "id"]
        })
      ).toThrow(/shell host/i);
    });

    it("rejects busybox sh / ash", () => {
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "busybox",
          args: ["sh", "-c", "echo x"]
        })
      ).toThrow(/shell host|BusyBox/i);
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "busybox",
          args: ["ash"]
        })
      ).toThrow(/shell host|BusyBox/i);
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "toybox",
          args: ["sh"]
        })
      ).toThrow(/shell host|BusyBox/i);
    });

    it("allows benign env and busybox non-shell applets at policy layer", () => {
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "env",
          args: ["NODE_ENV=test", "node", "--version"]
        })
      ).not.toThrow();
      expect(resolveWrapperCommandTarget("env", ["NODE_ENV=test", "node", "--version"])).toBe(
        "node"
      );
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "busybox",
          args: ["true"]
        })
      ).not.toThrow();
      expect(resolveWrapperCommandTarget("busybox", ["true"])).toBe("true");
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "busybox",
          args: ["ls", "-la"]
        })
      ).not.toThrow();
    });

    it("rejects xargs/nohup/setsid when target is a shell host; bans script", () => {
      expect(() =>
        assertNoShellHostInvocation({ executableBasename: "xargs", args: ["bash", "-c", "id"] })
      ).toThrow(/shell host/i);
      expect(() =>
        assertNoShellHostInvocation({ executableBasename: "nohup", args: ["sh", "-c", "id"] })
      ).toThrow(/shell host/i);
      expect(() =>
        assertNoShellHostInvocation({ executableBasename: "setsid", args: ["zsh"] })
      ).toThrow(/shell host/i);
      expect(() =>
        assertNoShellHostInvocation({ executableBasename: "script", args: ["-c", "echo hi"] })
      ).toThrow(/script/);
    });

    it("does not treat osascript as a shell host", () => {
      expect(isShellHostBasename("osascript")).toBe(false);
      expect(() =>
        assertNoShellHostInvocation({
          executableBasename: "osascript",
          args: ["-e", "return 1"]
        })
      ).not.toThrow();
    });
  });

  describe("interpreters preserved (not a sandbox)", () => {
    it("allows node --version / node -e and python3 -c at policy layer", () => {
      expect(() =>
        assertRemoteProcessExecuteParameters({
          executable: "node",
          args: ["--version"]
        })
      ).not.toThrow();
      expect(() =>
        assertRemoteProcessExecuteParameters({
          executable: "node",
          args: ["-e", "console.log('R22_2_OK')"]
        })
      ).not.toThrow();
      expect(() =>
        assertRemoteProcessExecuteParameters({
          executable: "python3",
          args: ["-c", "print('R22_2_OK')"]
        })
      ).not.toThrow();
    });

    it("Approve once still runs node -e (interpreter, not shell host)", async () => {
      const { service } = await harness();
      let state = grantProcess(baseState(kelvinId, [paulId]), paulId);
      const begun = await service.beginRequestAction(state, {
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "process.execute",
        parameters: {
          executable: "node",
          args: ["-e", "process.stdout.write('interp'); process.exit(0)"]
        }
      });
      expect(begun.execution.status).toBe("approval_required");
      const approved = await service.approveAction(begun.state, {
        actionId: begun.execution.actionId,
        decision: "allow-once"
      });
      expect(approved.execution.status).toBe("completed");
      expect(approved.execution.result?.outputs?.stdout).toBe("interp");
      expect(service.processExecuteExecutorInstance?.processInvocationCount).toBe(1);
    });
  });

  describe("Windows .cmd / .bat / PATHEXT", () => {
    it("rejects .cmd/.bat basenames and resolved paths (mocked)", () => {
      expect(isWindowsShellScriptPath("build.cmd")).toBe(true);
      expect(isWindowsShellScriptPath("run.bat")).toBe(true);
      expect(isWindowsShellScriptPath("tool.exe")).toBe(false);
      expect(() =>
        assertNoShellHostInvocation({ executableBasename: "build.cmd", args: [] })
      ).toThrow(/\.cmd|\.bat|shell/i);
      expect(() =>
        assertResolvedExecutableNotWindowsShellScript("C:\\Windows\\System32\\foo.cmd")
      ).toThrow(/\.cmd|\.bat|shell/i);
      expect(() => assertResolvedExecutableNotWindowsShellScript("/tmp/run.bat")).toThrow(
        /\.cmd|\.bat|shell/i
      );
    });
  });

  describe("cwd TOCTOU", () => {
    it("valid cwd executes under Approve once", async () => {
      const { service } = await harness();
      let state = grantProcess(baseState(kelvinId, [paulId]), paulId);
      const begun = await service.beginRequestAction(state, {
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "process.execute",
        parameters: {
          executable: "node",
          args: ["-e", "process.stdout.write('cwdok'); process.exit(0)"],
          cwd: "src"
        }
      });
      const approved = await service.approveAction(begun.state, {
        actionId: begun.execution.actionId,
        decision: "allow-once"
      });
      expect(approved.execution.status).toBe("completed");
      expect(approved.execution.result?.outputs?.stdout).toBe("cwdok");
    });

    it("rejects disappeared cwd", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-cwd-rm-"));
      await mkdir(join(workspace, "gone"), { recursive: true });
      const ok = await validateProcessCwd({ workspaceRoot: workspace, cwdRelative: "gone" });
      expect(ok.cwdRelative).toBe("gone");
      await rm(join(workspace, "gone"), { recursive: true, force: true });
      await expect(
        validateProcessCwd({
          workspaceRoot: workspace,
          cwdRelative: "gone",
          expectedCwdRelative: "gone"
        })
      ).rejects.toMatchObject({ code: "pairmesh.boundary_violation" });
    });

    it("rejects cwd swapped to external symlink", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-cwd-ext-"));
      const outside = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-out-"));
      await mkdir(join(workspace, "inner"), { recursive: true });
      await validateProcessCwd({ workspaceRoot: workspace, cwdRelative: "inner" });
      await rm(join(workspace, "inner"), { recursive: true, force: true });
      await symlink(outside, join(workspace, "inner"));
      await expect(
        validateProcessCwd({
          workspaceRoot: workspace,
          cwdRelative: "inner",
          expectedCwdRelative: "inner"
        })
      ).rejects.toMatchObject({ code: "pairmesh.boundary_violation" });
    });

    it("rejects parent swapped to external symlink", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-cwd-par-"));
      const outside = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-par-out-"));
      await mkdir(join(outside, "nested"), { recursive: true });
      await mkdir(join(workspace, "parent", "nested"), { recursive: true });
      await validateProcessCwd({
        workspaceRoot: workspace,
        cwdRelative: "parent/nested"
      });
      await rm(join(workspace, "parent"), { recursive: true, force: true });
      await symlink(outside, join(workspace, "parent"));
      await expect(
        validateProcessCwd({
          workspaceRoot: workspace,
          cwdRelative: "parent/nested",
          expectedCwdRelative: "parent/nested"
        })
      ).rejects.toMatchObject({ code: "pairmesh.boundary_violation" });
    });

    it("allows internal symlink remaining inside workspace root", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-cwd-int-"));
      await mkdir(join(workspace, "real"), { recursive: true });
      await symlink(join(workspace, "real"), join(workspace, "alias"));
      const confined = await validateProcessCwd({
        workspaceRoot: workspace,
        cwdRelative: "alias"
      });
      expect(confined.cwdRelative).toBe("real");
      expect(confined.cwdAbsolute).toContain(workspace);
    });

    it("rejects approved cwd identity mismatch", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-cwd-id-"));
      await mkdir(join(workspace, "a"), { recursive: true });
      await mkdir(join(workspace, "b"), { recursive: true });
      await expect(
        validateProcessCwd({
          workspaceRoot: workspace,
          cwdRelative: "b",
          expectedCwdRelative: "a"
        })
      ).rejects.toMatchObject({ code: "pairmesh.boundary_violation" });
    });

    it("pre-spawn cwd escape after approval fails closed without spawn", async () => {
      const { service, workspace } = await harness();
      await mkdir(join(workspace, "work"), { recursive: true });
      const outside = await mkdtemp(join(tmpdir(), "pairmesh-r22-2-escape-"));
      let state = grantProcess(baseState(kelvinId, [paulId]), paulId);
      const begun = await service.beginRequestAction(state, {
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "process.execute",
        parameters: {
          executable: "node",
          args: ["-e", "process.stdout.write('SHOULD_NOT'); process.exit(0)"],
          cwd: "work"
        }
      });
      expect(begun.execution.status).toBe("approval_required");

      await rm(join(workspace, "work"), { recursive: true, force: true });
      await symlink(outside, join(workspace, "work"));

      await expect(
        service.approveAction(begun.state, {
          actionId: begun.execution.actionId,
          decision: "allow-once"
        })
      ).rejects.toMatchObject({ code: "pairmesh.boundary_violation" });
      expect(service.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
    });
  });

  describe("authority + execution safety regression", () => {
    it("forbids allow_session; Approve once required; grantable list intact", () => {
      expect(PAIRMESH_GRANTABLE_CAPABILITIES).toContain("process.execute");
      expect(isAllowSessionForbidden("process.execute", "allow_session")).toBe(true);
      const state = baseState(kelvinId, [paulId]);
      expect(() => setGrantPolicy(state, paulId, "process.execute", "allow_session")).toThrow(
        /allow_session/
      );
    });

    it("rejects wrapper shell at beginRequest (no approval path)", async () => {
      const { service } = await harness();
      const state = grantProcess(baseState(kelvinId, [paulId]), paulId);
      await expect(
        service.beginRequestAction(state, {
          requesterParticipantId: paulId,
          targetParticipantId: kelvinId,
          actionType: "process.execute",
          parameters: {
            executable: "env",
            args: ["bash", "-c", "echo no"]
          }
        })
      ).rejects.toMatchObject({ code: "pairmesh.process_executable_invalid" });
      expect(service.processExecuteExecutorInstance?.processInvocationCount ?? 0).toBe(0);
    });

    it("does not double-spawn on duplicate actionId", async () => {
      const { service } = await harness();
      let state = grantProcess(baseState(kelvinId, [paulId]), paulId);
      const begun = await service.beginRequestAction(state, {
        requesterParticipantId: paulId,
        targetParticipantId: kelvinId,
        actionType: "process.execute",
        parameters: {
          executable: "node",
          args: ["-e", "process.stdout.write('once'); process.exit(0)"]
        }
      });
      const approved = await service.approveAction(begun.state, {
        actionId: begun.execution.actionId,
        decision: "allow-once"
      });
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
  });
});
