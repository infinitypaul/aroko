import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  initLocalConfig,
  inspectManagedRuntime,
  readRuntimeInfo,
  resolveLocalRuntime,
  runtimeLogFilePath
} from "@pairmesh/client";
import {
  resolveRuntimeForStart,
  startBackgroundRuntime,
  stopBackgroundRuntime
} from "./background-runtime.js";

describe.sequential("background runtime lifecycle", () => {
  const tempDirs: string[] = [];
  const startedWorkspaces: string[] = [];

  afterEach(async () => {
    for (const workspace of startedWorkspaces.splice(0)) {
      try {
        await stopBackgroundRuntime({ workspace, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeProject(port: number): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-bg-runtime-"));
    tempDirs.push(workspace);
    await initLocalConfig({
      workspace,
      agentName: "bg-test-agent",
      provider: "fake",
      port
    });
    return workspace;
  }

  it("starts in background, returns while process stays alive", async () => {
    const workspace = await makeProject(47_210);
    const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
    const result = await startBackgroundRuntime(runtime);
    startedWorkspaces.push(workspace);

    expect(result.alreadyRunning).toBe(false);
    expect(result.pid).toBeGreaterThan(0);

    const runtimeInfo = await readRuntimeInfo(workspace);
    expect(runtimeInfo?.mode).toBe("background");
    expect(runtimeInfo?.projectId).toBe(runtime.config.projectId);

    const inspection = await inspectManagedRuntime(workspace, runtime.config, runtimeInfo);
    expect(inspection.verified).toBe(true);
    expect(inspection.health?.status).toBeDefined();
  }, 30_000);

  it("does not start a second runtime when already running", async () => {
    const workspace = await makeProject(47_211);
    const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
    const first = await startBackgroundRuntime(runtime);
    startedWorkspaces.push(workspace);

    const second = await startBackgroundRuntime(runtime);
    expect(second.alreadyRunning).toBe(true);
    expect(second.pid).toBe(first.pid);
  }, 30_000);

  it("stops background runtime and clears metadata", async () => {
    const workspace = await makeProject(47_212);
    const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
    await startBackgroundRuntime(runtime);

    const stopped = await stopBackgroundRuntime({ workspace });
    expect(stopped).toBe(true);

    const runtimeInfo = await readRuntimeInfo(workspace);
    expect(runtimeInfo).toBeNull();

    const inspection = await inspectManagedRuntime(workspace, runtime.config, null);
    expect(inspection.verified).toBe(false);
  }, 30_000);

  it("preserves port on restart when available", async () => {
    const workspace = await makeProject(47_213);
    const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
    await startBackgroundRuntime(runtime);
    const before = await readRuntimeInfo(workspace);
    expect(before?.port).toBe(47_213);

    await stopBackgroundRuntime({ workspace });
    const restartRuntime = await resolveRuntimeForStart({ workspace, preservePort: true });
    const restarted = await startBackgroundRuntime(restartRuntime);
    startedWorkspaces.push(workspace);

    expect(restarted.alreadyRunning).toBe(false);
    expect(restartRuntime.port).toBe(47_213);
  }, 30_000);

  it("selects another port on restart when previous port is occupied", async () => {
    const workspace = await makeProject(47_214);
    const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
    await startBackgroundRuntime(runtime);
    await stopBackgroundRuntime({ workspace });

    const blocker = createServer();
    await new Promise<void>((resolvePromise) => {
      blocker.listen(47_214, "127.0.0.1", () => resolvePromise());
    });

    try {
      const restartRuntime = await resolveRuntimeForStart({ workspace, preservePort: true });
      expect(restartRuntime.port).not.toBe(47_214);

      const restarted = await startBackgroundRuntime(restartRuntime);
      startedWorkspaces.push(workspace);
      expect(restarted.alreadyRunning).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        blocker.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  }, 30_000);

  it("writes safe diagnostics without secret-like values", async () => {
    const workspace = await makeProject(47_215);
    process.env.PAIRMESH_TEST_SECRET = "super-secret-token-value";
    const runtime = await resolveLocalRuntime({ cwd: workspace, cli: { workspace } });
    await startBackgroundRuntime(runtime);
    startedWorkspaces.push(workspace);

    const logPath = runtimeLogFilePath(workspace);
    const logText = await readFile(logPath, "utf8");
    expect(logText).not.toContain("super-secret-token-value");
    delete process.env.PAIRMESH_TEST_SECRET;
  }, 30_000);
});
