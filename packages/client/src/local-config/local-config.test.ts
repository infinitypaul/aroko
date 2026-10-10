import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import {
  applyResolvedLocalRuntimeToEnv,
  initLocalConfig,
  loadConfigFile,
  resolveLocalRuntime,
  updateLocalConfigFile
} from "./resolver.js";
import { PAIRMESH_HOSTED_RELAY_WS_URL } from "../connectivity/hosted-relay-default.js";
import { configFilePath } from "./paths.js";
import { isPortAvailable, pickAvailablePort } from "./port.js";

describe("local config", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
    delete process.env.PAIRMESH_WORKSPACE;
    delete process.env.PAIRMESH_STATE_FILE;
    delete process.env.PAIRMESH_CODING_AGENT_PROVIDER;
    delete process.env.PAIRMESH_AGENT_PORT;
  });

  async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-local-config-"));
    tempDirs.push(dir);
    return dir;
  }

  it("init writes valid config with absolute workspace", async () => {
    const workspace = await makeWorkspace();
    const config = await initLocalConfig({
      workspace,
      agentName: "paul-agent",
      port: "auto"
    });

    expect(config.workspace).toBe(resolve(workspace));
    expect(config.agent.name).toBe("paul-agent");
    expect(config.connectivity.mode).toBe("relay");
    expect(config.connectivity.relayUrl).toBeUndefined();
    const onDisk = await loadConfigFile(configFilePath(workspace));
    expect(onDisk.projectId).toBe(config.projectId);
  });

  it("env overrides config for workspace and provider", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent", provider: "cursor" });

    process.env.PAIRMESH_CODING_AGENT_PROVIDER = "fake";
    const runtime = await resolveLocalRuntime({ cwd: workspace });
    expect(runtime.codingAgentProvider).toBe("fake");
  });

  it("applyResolvedLocalRuntimeToEnv sets process env", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent", provider: "fake" });
    const runtime = await resolveLocalRuntime({ cwd: workspace });
    applyResolvedLocalRuntimeToEnv(runtime);
    expect(process.env.PAIRMESH_WORKSPACE).toBe(runtime.workspace);
    expect(process.env.PAIRMESH_STATE_FILE).toBe(runtime.stateFilePath);
  });

  it("resolves project via PAIRMESH_PROJECT_ROOT when cwd is unrelated", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent", provider: "fake" });
    const outside = await makeWorkspace();

    const previousCwd = process.cwd();
    process.chdir(outside);
    process.env.PAIRMESH_PROJECT_ROOT = workspace;
    try {
      const runtime = await resolveLocalRuntime();
      expect(runtime.workspace).toBe(resolve(workspace));
    } finally {
      process.chdir(previousCwd);
      delete process.env.PAIRMESH_PROJECT_ROOT;
    }
  });

  it("resolveLocalRuntime exposes hosted relay default when relayUrl omitted", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent", provider: "fake" });
    const runtime = await resolveLocalRuntime({ cwd: workspace });
    expect(runtime.relayWsUrl).toBe(PAIRMESH_HOSTED_RELAY_WS_URL);
  });

  it("clearing connectivity.relayUrl restores hosted default (config unset semantics)", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent", provider: "fake" });
    const path = configFilePath(workspace);

    await updateLocalConfigFile(path, (current) => ({
      ...current,
      connectivity: {
        mode: "relay",
        relayUrl: "wss://relay.example.test/relay"
      }
    }));
    expect((await resolveLocalRuntime({ cwd: workspace })).relayWsUrl).toBe(
      "wss://relay.example.test/relay"
    );

    await updateLocalConfigFile(path, (current) => ({
      ...current,
      connectivity: {
        mode: current.connectivity.mode ?? "relay"
      }
    }));

    const after = await loadConfigFile(path);
    expect(after.connectivity.relayUrl).toBeUndefined();
    expect((await resolveLocalRuntime({ cwd: workspace })).relayWsUrl).toBe(
      PAIRMESH_HOSTED_RELAY_WS_URL
    );
  });

  it("picks another port when preferred is occupied", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "paul-agent", port: 47_120 });

    const blocker = createServer();
    await new Promise<void>((resolvePromise) => {
      blocker.listen(47_120, "127.0.0.1", () => resolvePromise());
    });

    try {
      expect(await isPortAvailable("127.0.0.1", 47_120)).toBe(false);
      const selected = await pickAvailablePort("127.0.0.1", 47_120);
      expect(selected).not.toBe(47_120);
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        blocker.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });
});
