import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalConfig } from "../local-config/resolver.js";
import { ensurePairMeshGitignore } from "./gitignore.js";
import {
  cursorMcpConfigPath,
  findPairMeshMonorepoRoot,
  mcpLaunchConfigsEqual,
  projectConfigSearchRoot,
  resolveMcpLaunchConfig,
  type McpLaunchConfig
} from "./mcp-launch.js";
import { inspectCursorMcpSetup, writeCursorMcpSetup } from "./cursor-config.js";

describe("cursor mcp setup", () => {
  const tempDirs: string[] = [];
  const monorepoRoot = resolve(import.meta.dirname, "../../../..");
  const testRoot = join(monorepoRoot, "packages/client/.test-tmp");
  /** Hosts that forbid creating `.cursor/` (Cursor agent) still exercise the same writer. */
  const cursorConfigDir = ".pairmesh-cursor-fixture";

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
    delete process.env.PAIRMESH_DEV_ROOT;
    delete process.env.AROKO_DEV_ROOT;
    delete process.env.INIT_CWD;
    delete process.env.PAIRMESH_CURSOR_CONFIG_DIR;
    delete process.env.AROKO_CURSOR_CONFIG_DIR;
  });

  async function makeWorkspace(): Promise<string> {
    process.env.PAIRMESH_CURSOR_CONFIG_DIR = cursorConfigDir;
    await mkdir(testRoot, { recursive: true });
    const dir = await mkdtemp(join(testRoot, "pairmesh-cursor-mcp-"));
    tempDirs.push(dir);
    return dir;
  }

  it("resolves development launch config from monorepo root", async () => {
    process.env.PAIRMESH_DEV_ROOT = monorepoRoot;
    const workspace = await makeWorkspace();
    const launch = await resolveMcpLaunchConfig({ workspace, mode: "development" });

    expect(launch.command).toBe("pnpm");
    expect(launch.args).toEqual(["--dir", monorepoRoot, "aroko", "mcp"]);
    expect(launch.cwd).toBe(".");
  });

  it("resolves installed launch config when monorepo is unavailable", async () => {
    const workspace = await makeWorkspace();
    const launch = await resolveMcpLaunchConfig({ workspace, mode: "installed" });

    expect(launch).toEqual({
      type: "stdio",
      command: "aroko",
      args: ["mcp"],
      cwd: ".",
      env: { AROKO_PROJECT_ROOT: workspace, PAIRMESH_PROJECT_ROOT: workspace }
    });
  });

  it("creates cursor mcp config when missing", async () => {
    process.env.PAIRMESH_DEV_ROOT = monorepoRoot;
    const workspace = await makeWorkspace();

    const result = await writeCursorMcpSetup({ workspace, write: true });
    expect(result.changed).toBe(true);
    expect(result.status).toBe("configured");

    const path = cursorMcpConfigPath(workspace);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as {
      mcpServers: { aroko: { command: string; args: string[]; cwd?: string } };
    };

    expect(parsed.mcpServers.aroko.command).toBe("pnpm");
    expect(parsed.mcpServers.aroko.args).toEqual(["--dir", monorepoRoot, "aroko", "mcp"]);
    expect(parsed.mcpServers.aroko.cwd).toBe(".");
  });

  it("merges existing mcp servers without mutation", async () => {
    process.env.PAIRMESH_DEV_ROOT = monorepoRoot;
    const workspace = await makeWorkspace();
    const cursorDir = join(workspace, cursorConfigDir);
    await mkdir(cursorDir, { recursive: true });
    await writeFile(
      join(cursorDir, "mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            github: { command: "something", args: [] },
            database: { command: "something-else" }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeCursorMcpSetup({ workspace, write: true });

    const parsed = JSON.parse(await readFile(join(cursorDir, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };

    expect(parsed.mcpServers.github).toEqual({ command: "something", args: [] });
    expect(parsed.mcpServers.database).toEqual({ command: "something-else" });
    expect(parsed.mcpServers.aroko.command).toBe("pnpm");
    expect(parsed.mcpServers.pairmesh).toBeUndefined();
  });

  it("is idempotent on repeated setup writes", async () => {
    process.env.PAIRMESH_DEV_ROOT = monorepoRoot;
    const workspace = await makeWorkspace();

    await writeCursorMcpSetup({ workspace, write: true });
    const first = await readFile(cursorMcpConfigPath(workspace), "utf8");

    const second = await writeCursorMcpSetup({ workspace, write: true });
    expect(second.changed).toBe(false);
    expect(second.status).toBe("configured");

    const after = await readFile(cursorMcpConfigPath(workspace), "utf8");
    expect(after).toBe(first);
  });

  it("reports conflict without force and preserves file", async () => {
    process.env.PAIRMESH_DEV_ROOT = monorepoRoot;
    const workspace = await makeWorkspace();
    const path = cursorMcpConfigPath(workspace);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          mcpServers: {
            pairmesh: { command: "old-command", args: ["mcp"] }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const inspection = await inspectCursorMcpSetup(workspace);
    expect(inspection.status).toBe("conflict");

    const result = await writeCursorMcpSetup({ workspace, write: true });
    expect(result.status).toBe("conflict");
    expect(result.changed).toBe(false);

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      mcpServers: { pairmesh: { command: string } };
    };
    expect(parsed.mcpServers.pairmesh.command).toBe("old-command");
  });

  it("replaces pairmesh entry with force while preserving other servers", async () => {
    process.env.PAIRMESH_DEV_ROOT = monorepoRoot;
    const workspace = await makeWorkspace();
    const path = cursorMcpConfigPath(workspace);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          mcpServers: {
            github: { command: "something", args: [] },
            pairmesh: { command: "old-command", args: ["mcp"] }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeCursorMcpSetup({ workspace, write: true, force: true });

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.mcpServers.github.command).toBe("something");
    expect(parsed.mcpServers.aroko.command).toBe("pnpm");
    expect(parsed.mcpServers.pairmesh).toBeUndefined();
  });

  it("fails safely on malformed json without modifying file", async () => {
    const workspace = await makeWorkspace();
    const path = cursorMcpConfigPath(workspace);
    await mkdir(dirname(path), { recursive: true });
    const malformed = "{ not-json";
    await writeFile(path, malformed, "utf8");

    await expect(writeCursorMcpSetup({ workspace, write: true })).rejects.toThrow(/invalid JSON/);
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it("detects doctor cursor mcp states", async () => {
    process.env.PAIRMESH_DEV_ROOT = monorepoRoot;
    const workspace = await makeWorkspace();

    expect((await inspectCursorMcpSetup(workspace)).status).toBe("missing");

    await writeCursorMcpSetup({ workspace, write: true });
    expect((await inspectCursorMcpSetup(workspace)).status).toBe("configured");

    const path = cursorMcpConfigPath(workspace);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{", "utf8");
    expect((await inspectCursorMcpSetup(workspace)).status).toBe("invalid");

    await writeFile(
      path,
      `${JSON.stringify({ mcpServers: { pairmesh: { command: "custom", args: [] } } })}\n`,
      "utf8"
    );
    expect((await inspectCursorMcpSetup(workspace)).status).toBe("conflict");
  });

  it("uses INIT_CWD as project config search root", () => {
    process.env.INIT_CWD = "/tmp/my-project";
    expect(projectConfigSearchRoot()).toBe("/tmp/my-project");
  });

  it("compares launch configs deterministically", () => {
    const left: McpLaunchConfig = {
      type: "stdio",
      command: "pnpm",
      args: ["pairmesh", "mcp"],
      cwd: "."
    };
    const right: McpLaunchConfig = {
      type: "stdio",
      command: "pnpm",
      args: ["pairmesh", "mcp"],
      cwd: "."
    };
    expect(mcpLaunchConfigsEqual(left, right)).toBe(true);
  });
});

describe("pairmesh gitignore protection", () => {
  const tempDirs: string[] = [];
  const testRoot = join(resolve(import.meta.dirname, "../../../.."), "packages/client/.test-tmp");

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeWorkspace(): Promise<string> {
    await mkdir(testRoot, { recursive: true });
    const dir = await mkdtemp(join(testRoot, "pairmesh-gitignore-"));
    tempDirs.push(dir);
    return dir;
  }

  it("creates gitignore in empty project", async () => {
    const workspace = await makeWorkspace();
    const result = await ensurePairMeshGitignore(workspace);
    expect(result.updated).toBe(true);
    expect(await readFile(join(workspace, ".gitignore"), "utf8")).toContain(".pairmesh/");
  });

  it("appends to existing gitignore without duplicates", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, ".gitignore"), "node_modules/\n", "utf8");

    const first = await ensurePairMeshGitignore(workspace);
    const second = await ensurePairMeshGitignore(workspace);

    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);

    const content = await readFile(join(workspace, ".gitignore"), "utf8");
    expect(content.match(/\.pairmesh\//g)?.length).toBe(1);
    expect(content).toContain("node_modules/");
  });

  it("succeeds without git repository", async () => {
    const workspace = await makeWorkspace();
    await initLocalConfig({ workspace, agentName: "test-agent" });
    const result = await ensurePairMeshGitignore(workspace);
    expect(result.updated).toBe(true);
    await expect(access(join(workspace, ".pairmesh", "config.json"))).resolves.toBeUndefined();
  });
});

describe("findPairMeshMonorepoRoot", () => {
  it("finds monorepo from workspace via PAIRMESH_DEV_ROOT", async () => {
    const monorepoRoot = resolve(import.meta.dirname, "../../../..");
    process.env.PAIRMESH_DEV_ROOT = monorepoRoot;
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-monorepo-"));
    try {
      expect(await findPairMeshMonorepoRoot(workspace)).toBe(monorepoRoot);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      delete process.env.PAIRMESH_DEV_ROOT;
    }
  });
});
