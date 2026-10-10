import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MCP_SERVER_KEY_CANONICAL,
  MCP_SERVER_KEY_LEGACY,
  mcpServerKeysPresent,
  pickMcpServerEntry
} from "@pairmesh/shared";
import {
  cursorMcpConfigPath,
  formatMcpLaunchSummary,
  mcpLaunchConfigsEqual,
  resolveMcpLaunchConfig,
  type McpLaunchConfig
} from "./mcp-launch.js";

export type CursorMcpSetupStatus = "missing" | "configured" | "conflict" | "invalid";

export interface CursorMcpServerEntry {
  type?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CursorMcpFile {
  mcpServers?: Record<string, CursorMcpServerEntry>;
}

export interface CursorMcpInspection {
  status: CursorMcpSetupStatus;
  targetPath: string;
  fileExists: boolean;
  proposed: McpLaunchConfig;
  current?: CursorMcpServerEntry;
  currentKey?: string;
  parsedFile?: CursorMcpFile;
  keysPresent?: { aroko: boolean; pairmesh: boolean; both: boolean };
  error?: string;
}

export interface WriteCursorMcpOptions {
  workspace: string;
  force?: boolean;
  write?: boolean;
}

export interface WriteCursorMcpResult {
  status: CursorMcpSetupStatus;
  changed: boolean;
  targetPath: string;
  message: string;
}

export async function inspectCursorMcpSetup(workspace: string): Promise<CursorMcpInspection> {
  const targetPath = cursorMcpConfigPath(workspace);
  const proposed = await resolveMcpLaunchConfig({ workspace });

  let fileExists = false;
  let parsedFile: CursorMcpFile | undefined;
  try {
    const raw = await readFile(targetPath, "utf8");
    fileExists = true;
    try {
      parsedFile = JSON.parse(raw) as CursorMcpFile;
    } catch {
      return {
        status: "invalid",
        targetPath,
        fileExists,
        proposed,
        error: "invalid JSON"
      };
    }
  } catch {
    return {
      status: "missing",
      targetPath,
      fileExists: false,
      proposed
    };
  }

  const keysPresent = mcpServerKeysPresent(parsedFile?.mcpServers);
  const picked = pickMcpServerEntry(parsedFile?.mcpServers);
  if (!picked) {
    return {
      status: "missing",
      targetPath,
      fileExists,
      proposed,
      parsedFile,
      keysPresent
    };
  }

  const current = picked.entry;
  const currentLaunch = cursorEntryToLaunchConfig(current);
  // Prefer canonical key when both exist and force-write will consolidate.
  if (mcpLaunchConfigsEqual(currentLaunch, proposed) && !keysPresent.both) {
    return {
      status: "configured",
      targetPath,
      fileExists,
      proposed,
      current,
      currentKey: picked.key,
      parsedFile,
      keysPresent
    };
  }

  if (mcpLaunchConfigsEqual(currentLaunch, proposed) && keysPresent.both) {
    // Dual keys with matching launch — treat as conflict so --write --force can consolidate.
    return {
      status: "conflict",
      targetPath,
      fileExists,
      proposed,
      current,
      currentKey: picked.key,
      parsedFile,
      keysPresent
    };
  }

  return {
    status: "conflict",
    targetPath,
    fileExists,
    proposed,
    current,
    currentKey: picked.key,
    parsedFile,
    keysPresent
  };
}

export async function writeCursorMcpSetup(
  options: WriteCursorMcpOptions
): Promise<WriteCursorMcpResult> {
  const inspection = await inspectCursorMcpSetup(options.workspace);

  if (inspection.status === "invalid") {
    throw new Error(
      "Cannot update .cursor/mcp.json because it contains invalid JSON.\n\nFix the file and retry:\n\n  aroko cursor setup --write"
    );
  }

  if (inspection.status === "configured") {
    return {
      status: "configured",
      changed: false,
      targetPath: inspection.targetPath,
      message: "Cursor MCP configuration is already up to date."
    };
  }

  if (inspection.status === "conflict" && !options.force) {
    const current = inspection.current;
    return {
      status: "conflict",
      changed: false,
      targetPath: inspection.targetPath,
      message: [
        "Aroko MCP configuration already exists (or a legacy pairmesh entry differs).",
        "",
        "Current:",
        current ? `  command: ${current.command}` : "  (missing command)",
        current?.args ? `  args: ${current.args.join(" ")}` : "",
        inspection.keysPresent?.both
          ? "  note: both mcpServers.aroko and mcpServers.pairmesh are present"
          : "",
        "",
        "Proposed:",
        formatMcpLaunchSummary(inspection.proposed),
        "",
        "Use --force to replace with a single mcpServers.aroko entry."
      ]
        .filter(Boolean)
        .join("\n")
    };
  }

  if (!options.write) {
    return {
      status: inspection.status,
      changed: false,
      targetPath: inspection.targetPath,
      message: "Dry run only."
    };
  }

  const nextServers: Record<string, CursorMcpServerEntry> = {
    ...(inspection.parsedFile?.mcpServers ?? {})
  };
  // Canonical write: set aroko, remove legacy pairmesh to avoid duplicate active servers.
  nextServers[MCP_SERVER_KEY_CANONICAL] = launchConfigToCursorEntry(inspection.proposed);
  delete nextServers[MCP_SERVER_KEY_LEGACY];

  const merged: CursorMcpFile = {
    ...(inspection.parsedFile ?? {}),
    mcpServers: nextServers
  };

  await mkdir(dirname(inspection.targetPath), { recursive: true });

  if (inspection.fileExists) {
    await writeFile(
      `${inspection.targetPath}.pairmesh-backup`,
      JSON.stringify(inspection.parsedFile, null, 2) + "\n",
      "utf8"
    );
  }

  const tempPath = `${inspection.targetPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(tempPath, inspection.targetPath);

  return {
    status: "configured",
    changed: true,
    targetPath: inspection.targetPath,
    message: "Cursor MCP configuration updated (mcpServers.aroko)."
  };
}

export function launchConfigToCursorEntry(config: McpLaunchConfig): CursorMcpServerEntry {
  return {
    type: config.type,
    command: config.command,
    args: config.args,
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.env ? { env: config.env } : {})
  };
}

export function cursorEntryToLaunchConfig(entry: CursorMcpServerEntry): McpLaunchConfig {
  return {
    type: "stdio",
    command: entry.command,
    args: entry.args ?? [],
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.env ? { env: entry.env } : {})
  };
}

export async function readCursorMcpFile(path: string): Promise<CursorMcpFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as CursorMcpFile;
  } catch {
    return null;
  }
}

export async function cleanupCursorMcpBackup(path: string): Promise<void> {
  await rm(`${path}.pairmesh-backup`, { force: true });
}
