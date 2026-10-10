import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readBrandedEnv } from "@pairmesh/shared";

export type McpLaunchMode = "development" | "installed";

export interface McpLaunchConfig {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ResolveMcpLaunchOptions {
  workspace: string;
  mode?: McpLaunchMode;
  monorepoRoot?: string;
}

export function projectConfigSearchRoot(): string {
  const projectRoot = readBrandedEnv({
    aroko: "AROKO_PROJECT_ROOT",
    pairmesh: "PAIRMESH_PROJECT_ROOT"
  });
  if (projectRoot) {
    return resolve(projectRoot);
  }
  const initCwd = process.env.INIT_CWD?.trim();
  if (initCwd) {
    return resolve(initCwd);
  }
  const pwd = process.env.PWD?.trim();
  if (pwd) {
    return resolve(pwd);
  }
  return process.cwd();
}

export async function findPairMeshMonorepoRoot(startDir: string): Promise<string | null> {
  const override = readBrandedEnv({
    aroko: "AROKO_DEV_ROOT",
    pairmesh: "PAIRMESH_DEV_ROOT"
  });
  if (override) {
    return resolve(override);
  }

  let current = resolve(startDir);
  const root = resolve("/");

  while (true) {
    const packageJsonPath = join(current, "package.json");
    try {
      const raw = await readFile(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as { name?: string };
      // Accept legacy root name `pairmesh` and canonical `aroko`.
      if (parsed.name === "aroko" || parsed.name === "pairmesh") {
        await access(join(current, "pnpm-workspace.yaml"));
        return current;
      }
    } catch {
      // continue
    }

    if (current === root) {
      return null;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function isInstalledPairMeshExecution(entryPath = process.argv[1]): boolean {
  if (!entryPath) {
    return false;
  }
  const normalized = entryPath.replaceAll("\\", "/");
  return (
    normalized.includes("/node_modules/@pairmesh/cli/") ||
    normalized.includes("/node_modules/.pnpm/@pairmesh+cli@") ||
    normalized.includes("/node_modules/@arokodev/cli/") ||
    normalized.includes("/node_modules/.pnpm/@arokodev+cli@") ||
        normalized.includes("/node_modules/@aroko/cli/") ||
    normalized.includes("/node_modules/.pnpm/@aroko+cli@")
  );
}

export async function resolveDefaultMcpLaunchMode(): Promise<McpLaunchMode> {
  const override = readBrandedEnv({
    aroko: "AROKO_LAUNCH_MODE",
    pairmesh: "PAIRMESH_LAUNCH_MODE"
  });
  if (override === "development" || override === "installed") {
    return override;
  }
  if (isInstalledPairMeshExecution()) {
    return "installed";
  }
  const monorepoRoot = await findPairMeshMonorepoRoot(projectConfigSearchRoot());
  return monorepoRoot ? "development" : "installed";
}

function projectRootEnv(workspace: string): Record<string, string> {
  const resolved = resolve(workspace);
  // Set both keys so legacy and new consumers see the same root.
  return {
    AROKO_PROJECT_ROOT: resolved,
    PAIRMESH_PROJECT_ROOT: resolved
  };
}

export async function resolveMcpLaunchConfig(
  options: ResolveMcpLaunchOptions
): Promise<McpLaunchConfig> {
  const workspace = resolve(options.workspace);
  const mode = options.mode ?? (await resolveDefaultMcpLaunchMode());

  if (mode === "installed") {
    const guiSafe =
      readBrandedEnv({ aroko: "AROKO_GUI_SAFE_MCP", pairmesh: "PAIRMESH_GUI_SAFE_MCP" }) === "1";
    if (guiSafe) {
      const nodeBin =
        readBrandedEnv({ aroko: "AROKO_NODE_BIN", pairmesh: "PAIRMESH_NODE_BIN" }) ||
        process.execPath;
      const cliEntryPath =
        readBrandedEnv({ aroko: "AROKO_CLI_ENTRY", pairmesh: "PAIRMESH_CLI_ENTRY" }) ||
        process.argv[1]?.replaceAll("\\", "/") ||
        "aroko";
      return resolveGuiSafeInstalledMcpLaunchConfig({
        workspace,
        nodeBin,
        cliEntryPath
      });
    }

    return {
      type: "stdio",
      command: "aroko",
      args: ["mcp"],
      cwd: ".",
      env: projectRootEnv(workspace)
    };
  }

  const monorepoRoot =
    options.monorepoRoot ?? (await findPairMeshMonorepoRoot(workspace)) ?? undefined;

  if (!monorepoRoot) {
    return {
      type: "stdio",
      command: "aroko",
      args: ["mcp"],
      cwd: ".",
      env: projectRootEnv(workspace)
    };
  }

  return {
    type: "stdio",
    command: "pnpm",
    args: ["--dir", monorepoRoot, "aroko", "mcp"],
    cwd: ".",
    env: projectRootEnv(workspace)
  };
}

export function resolveGuiSafeInstalledMcpLaunchConfig(options: {
  workspace: string;
  nodeBin: string;
  cliEntryPath: string;
}): McpLaunchConfig {
  return {
    type: "stdio",
    command: options.nodeBin,
    args: [options.cliEntryPath, "mcp"],
    cwd: ".",
    env: projectRootEnv(options.workspace)
  };
}

export function mcpLaunchConfigsEqual(
  left: McpLaunchConfig | undefined,
  right: McpLaunchConfig | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  const leftEnv = left.env ?? {};
  const rightEnv = right.env ?? {};
  const envKeys = new Set([...Object.keys(leftEnv), ...Object.keys(rightEnv)]);
  return (
    left.type === right.type &&
    left.command === right.command &&
    left.cwd === right.cwd &&
    left.args.length === right.args.length &&
    left.args.every((value, index) => value === right.args[index]) &&
    [...envKeys].every((key) => leftEnv[key] === rightEnv[key])
  );
}

export function formatMcpLaunchSummary(config: McpLaunchConfig): string {
  const cwd = config.cwd ? `\n    cwd: ${config.cwd}` : "";
  return [
    `  aroko`,
    `    command: ${config.command}`,
    `    args: ${config.args.join(" ")}${cwd}`
  ].join("\n");
}

export async function validateMcpLaunchConfig(config: McpLaunchConfig): Promise<void> {
  if (config.command === "pnpm") {
    const dirArgIndex = config.args.indexOf("--dir");
    if (dirArgIndex >= 0) {
      const monorepoRoot = config.args[dirArgIndex + 1];
      if (!monorepoRoot) {
        throw new Error("Aroko MCP launch config is missing a monorepo root.");
      }
      await access(resolve(monorepoRoot));
    }
    return;
  }

  if (config.command === "aroko" || config.command === "pairmesh") {
    return;
  }

  if (config.command === "node") {
    const script = config.args[0];
    if (script) {
      await access(resolve(script));
    }
  }
}

/**
 * Cursor MCP config path. Defaults to `<workspace>/.cursor/mcp.json`.
 * Tests may set AROKO_CURSOR_CONFIG_DIR / PAIRMESH_CURSOR_CONFIG_DIR when
 * the host forbids creating directories named `.cursor`.
 */
export function cursorMcpConfigPath(workspace: string): string {
  const dirName =
    readBrandedEnv({
      aroko: "AROKO_CURSOR_CONFIG_DIR",
      pairmesh: "PAIRMESH_CURSOR_CONFIG_DIR"
    }) || ".cursor";
  return join(resolve(workspace), dirName, "mcp.json");
}

export async function resolveConfigFilePath(configFile: string): Promise<string> {
  if (configFile.startsWith("/") || /^[A-Za-z]:[\\/]/.test(configFile)) {
    return resolve(configFile);
  }
  return resolve(projectConfigSearchRoot(), configFile);
}

export function monorepoRootFromLaunchConfig(config: McpLaunchConfig): string | undefined {
  const dirIndex = config.args.indexOf("--dir");
  if (dirIndex >= 0) {
    return config.args[dirIndex + 1];
  }
  return undefined;
}
