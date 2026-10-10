import { describe, expect, it, afterEach } from "vitest";
import {
  isInstalledPairMeshExecution,
  resolveDefaultMcpLaunchMode,
  resolveMcpLaunchConfig
} from "./mcp-launch.js";

describe("MCP launch mode", () => {
  afterEach(() => {
    delete process.env.PAIRMESH_LAUNCH_MODE;
    delete process.env.AROKO_LAUNCH_MODE;
    delete process.env.PAIRMESH_DEV_ROOT;
    delete process.env.AROKO_DEV_ROOT;
  });

  it("detects installed execution from node_modules path", () => {
    expect(
      isInstalledPairMeshExecution("/tmp/global/lib/node_modules/@pairmesh/cli/dist/index.js")
    ).toBe(true);
    expect(isInstalledPairMeshExecution("/Users/dev/pairmesh/apps/cli/dist/index.js")).toBe(false);
  });

  it("prefers installed mode for installed execution", async () => {
    process.env.PAIRMESH_LAUNCH_MODE = "installed";
    const mode = await resolveDefaultMcpLaunchMode();
    expect(mode).toBe("installed");
  });

  it("resolves installed launch config", async () => {
    const workspace = "/tmp/external-project";
    const launch = await resolveMcpLaunchConfig({ workspace, mode: "installed" });
    expect(launch).toEqual({
      type: "stdio",
      command: "aroko",
      args: ["mcp"],
      cwd: ".",
      env: { AROKO_PROJECT_ROOT: workspace, PAIRMESH_PROJECT_ROOT: workspace }
    });
  });

  it("detects installed execution from @arokodev/cli path", () => {
    expect(
      isInstalledPairMeshExecution("/tmp/prefix/lib/node_modules/@arokodev/cli/dist/index.js")
    ).toBe(true);
  });
});
