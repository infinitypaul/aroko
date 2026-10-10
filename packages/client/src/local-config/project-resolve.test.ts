import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalConfig } from "./resolver.js";
import {
  findPairMeshProjectRoot,
  PairMeshProjectNotFoundError,
  resolvePairMeshProjectRoot,
  buildProjectDiscoveryStartDirs,
  resolvePairMeshProjectAmong
} from "./project-resolve.js";
import { inspectManagedRuntime } from "../local-runtime/runtime-manager.js";
import { configFilePath } from "./paths.js";

describe("project resolution", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    delete process.env.PAIRMESH_PROJECT_ROOT;
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeProject(relativeParts: string[] = []): Promise<{
    root: string;
    nested: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "pairmesh-project-"));
    tempDirs.push(root);
    let current = root;
    for (const part of relativeParts) {
      current = join(current, part);
      await mkdir(current, { recursive: true });
    }
    await initLocalConfig({ workspace: root, agentName: "test-agent", provider: "fake" });
    return { root, nested: current };
  }

  it("resolves nearest ancestor from nested directory", async () => {
    const { root, nested } = await makeProject(["src", "deep", "path"]);
    const resolved = await findPairMeshProjectRoot(nested);
    expect(resolved).toBe(resolve(root));
  });

  it("prefers nearest nested PairMesh project", async () => {
    const parent = await makeProject(["services"]);
    const childRoot = join(parent.nested, "payment");
    await mkdir(childRoot, { recursive: true });
    await initLocalConfig({ workspace: childRoot, agentName: "child-agent", provider: "fake" });
    const deep = join(childRoot, "src");
    await mkdir(deep, { recursive: true });

    const resolved = await findPairMeshProjectRoot(deep);
    expect(resolved).toBe(resolve(childRoot));
  });

  it("throws when no project is found", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pairmesh-outside-"));
    tempDirs.push(outside);
    await expect(resolvePairMeshProjectRoot({ cwd: outside })).rejects.toBeInstanceOf(
      PairMeshProjectNotFoundError
    );
  });

  it("honors explicit workspace override", async () => {
    const { root, nested } = await makeProject(["src"]);
    const other = await makeProject();
    const resolved = await resolvePairMeshProjectRoot({
      explicitWorkspace: other.root,
      cwd: nested
    });
    expect(resolved).toBe(resolve(other.root));
    expect(resolved).not.toBe(resolve(root));
  });

  it("orders multi-root start dirs: active file, owning folder, then other roots", () => {
    const starts = buildProjectDiscoveryStartDirs({
      activeFilePath: "/ws/b/packages/api/src/index.ts",
      workspaceFolderPaths: ["/ws/a", "/ws/b"]
    });
    expect(starts[0]).toBe(resolve("/ws/b/packages/api/src"));
    expect(starts[1]).toBe(resolve("/ws/b"));
    expect(starts[2]).toBe(resolve("/ws/a"));
  });

  it("prefers PAIRMESH_PROJECT_ROOT among multi-root candidates when valid", async () => {
    const a = await makeProject();
    const b = await makeProject();
    const resolved = await resolvePairMeshProjectAmong({
      startDirs: [a.root],
      envProjectRoot: b.root
    });
    expect(resolved).toBe(resolve(b.root));
  });

  it("prefers a candidate with live control runtime among multi-root projects", async () => {
    const first = await makeProject();
    const second = await makeProject();
    const resolved = await resolvePairMeshProjectAmong({
      startDirs: [first.root, second.root],
      hasControlRuntime: async (projectRoot) => projectRoot === resolve(second.root)
    });
    expect(resolved).toBe(resolve(second.root));
  });
});

describe("runtime identity safety", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("treats metadata as stale when PID exists but health identity mismatches", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-runtime-stale-"));
    tempDirs.push(workspace);
    const config = await initLocalConfig({ workspace, agentName: "test-agent", provider: "fake" });

    const blocker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });
    await new Promise<void>((resolvePromise) => {
      blocker.once("spawn", () => resolvePromise());
    });

    try {
      await writeFile(
        configFilePath(workspace).replace("config.json", "runtime.json"),
        `${JSON.stringify({
          pid: blocker.pid,
          port: 47_199,
          baseUrl: "http://127.0.0.1:47199",
          agentName: config.agent.name,
          projectId: config.projectId,
          startedAt: new Date().toISOString(),
          mode: "background"
        })}\n`,
        "utf8"
      );

      const runtimeInfo = {
        pid: blocker.pid!,
        port: 47_199,
        baseUrl: "http://127.0.0.1:47199",
        agentName: config.agent.name,
        projectId: config.projectId,
        startedAt: new Date().toISOString(),
        mode: "background" as const
      };

      const inspection = await inspectManagedRuntime(workspace, config, runtimeInfo);
      expect(inspection.stale).toBe(true);
      expect(inspection.verified).toBe(false);
    } finally {
      blocker.kill("SIGTERM");
    }
  });
});
