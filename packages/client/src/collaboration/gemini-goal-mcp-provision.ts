/**
 * R5-7G — Transactional Gemini project MCP provisioning for Aroko goal mode.
 *
 * Mutates workspace `.gemini/settings.json` only when necessary, with:
 * - byte-exact backup before write
 * - ownership markers (never delete unknown servers)
 * - mcp.allowed / includeTools isolation for the goal turn when CLI flags unavailable
 * - restore on success/failure; crash-reconcile on next provision
 *
 * Prefer invocation-time `--allowed-mcp-server-names` when Gemini CLI supports it
 * so unrelated project MCP servers are not visible during the goal turn.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildGoalHostMcpLaunch, type GoalHostMcpLaunch } from "./goal-host-mcp-config.js";
import { PAIRMESH_GOAL_HOST_TOOLS } from "./goal-host-tools.js";

export const PAIRMESH_GEMINI_GOAL_OWNER_ENV = "PAIRMESH_AROOKO_GOAL_MCP_OWNER" as const;
export const PAIRMESH_GEMINI_GOAL_MARK_ENV = "PAIRMESH_AROOKO_GOAL_MCP" as const;

/**
 * Gemini FQN is `mcp_{server}_{tool}`. Underscores in the server name break
 * Gemini's policy parser — use a hyphenated Gemini-only registration name.
 * Claude/Cursor continue to use `pairmesh_goal`.
 */
export const PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME = "pairmesh-goal" as const;

const SETTINGS_REL = join(".gemini", "settings.json");
const BACKUP_PREFIX = "pairmesh-goal-settings-backup-";
const LOCK_REL = join(".gemini", "pairmesh-goal-mcp.lock");

/** Built-in mutators excluded for Aroko goal turns (defense in depth; headless already denies). */
const GEMINI_GOAL_EXCLUDED_TOOLS = [
  "run_shell_command",
  "write_file",
  "replace",
  "web_fetch"
] as const;

export interface GeminiGoalMcpProvisionResult {
  ownerToken: string;
  settingsPath: string;
  backupPath: string | null;
  createdSettingsDir: boolean;
  /** Snapshot hash before mutation (empty if no prior file). */
  priorHash: string;
  /** Hash of the settings file Aroko wrote for this turn. */
  provisionedHash: string;
  launch: GoalHostMcpLaunch;
  allowedMcpServerNames: string[];
  includeTools: string[];
}

function settingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, SETTINGS_REL);
}

function backupPath(workspaceRoot: string, ownerToken: string): string {
  return join(workspaceRoot, ".gemini", `${BACKUP_PREFIX}${ownerToken}.json`);
}

function lockPath(workspaceRoot: string): string {
  return join(workspaceRoot, LOCK_REL);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildGeminiGoalMcpServerEntry(
  launch: GoalHostMcpLaunch,
  ownerToken: string
): Record<string, unknown> {
  const includeTools = PAIRMESH_GOAL_HOST_TOOLS.map((tool) => tool.name);
  return {
    command: launch.command,
    args: launch.args,
    env: {
      ...launch.env,
      [PAIRMESH_GEMINI_GOAL_MARK_ENV]: "1",
      [PAIRMESH_GEMINI_GOAL_OWNER_ENV]: ownerToken
    },
    timeout: 60_000,
    // request_* only creates Aroko children — does not execute Actions.
    trust: true,
    includeTools
  };
}

export function isArokoOwnedGeminiGoalServer(entry: unknown): boolean {
  const root = asRecord(entry);
  const env = asRecord(root?.env);
  return env?.[PAIRMESH_GEMINI_GOAL_MARK_ENV] === "1";
}

async function acquireLock(workspaceRoot: string, ownerToken: string): Promise<void> {
  const path = lockPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      await writeFile(path, `${ownerToken}\n${new Date().toISOString()}\n`, {
        flag: "wx",
        encoding: "utf8"
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("Timed out acquiring Gemini goal MCP settings lock.");
}

async function releaseLock(workspaceRoot: string, ownerToken: string): Promise<void> {
  const path = lockPath(workspaceRoot);
  try {
    const body = await readFile(path, "utf8");
    if (!body.startsWith(ownerToken)) {
      return;
    }
    await rm(path, { force: true });
  } catch {
    // ignore
  }
}

/**
 * Reconcile stale Aroko-owned pairmesh_goal entries left after a crash.
 * Only removes servers that carry our ownership marker. Restores from backup
 * when a matching backup file exists.
 */
export async function reconcileStaleGeminiGoalMcp(workspaceRoot: string): Promise<{
  restoredFromBackup: boolean;
  removedStaleServer: boolean;
}> {
  const path = settingsPath(workspaceRoot);
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { restoredFromBackup: false, removedStaleServer: false };
  }

  // Prefer restoring a leftover backup if present (crash mid-turn).
  const geminiDir = join(workspaceRoot, ".gemini");
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(geminiDir);
    const backups = files.filter(
      (name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(".json")
    );
    if (backups.length === 1) {
      const token = backups[0]!.slice(BACKUP_PREFIX.length, -".json".length);
      const backup = await readFile(join(geminiDir, backups[0]!), "utf8");
      if (backup.length === 0) {
        await rm(path, { force: true });
      } else {
        await writeFile(path, backup, "utf8");
      }
      await rm(join(geminiDir, backups[0]!), { force: true });
      await rm(lockPath(workspaceRoot), { force: true }).catch(() => undefined);
      void token;
      return { restoredFromBackup: true, removedStaleServer: false };
    }
  } catch {
    // continue with marker-based cleanup
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { restoredFromBackup: false, removedStaleServer: false };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { restoredFromBackup: false, removedStaleServer: false };
  }
  const servers = asRecord(root.mcpServers);
  if (!servers || !(PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME in servers)) {
    return { restoredFromBackup: false, removedStaleServer: false };
  }
  if (!isArokoOwnedGeminiGoalServer(servers[PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME])) {
    return { restoredFromBackup: false, removedStaleServer: false };
  }
  delete servers[PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME];
  // If we temporarily forced mcp.allowed to only our server, clear that only when
  // it is exactly ["pairmesh-goal"] (our stamp).
  const mcp = asRecord(root.mcp);
  if (
    mcp &&
    Array.isArray(mcp.allowed) &&
    mcp.allowed.length === 1 &&
    mcp.allowed[0] === PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME
  ) {
    delete mcp.allowed;
    if (Object.keys(mcp).length === 0) {
      delete root.mcp;
    } else {
      root.mcp = mcp;
    }
  }
  root.mcpServers = servers;
  if (Object.keys(servers).length === 0) {
    delete root.mcpServers;
  }
  const next = `${JSON.stringify(root, null, 2)}\n`;
  await writeFile(path, next, "utf8");
  return { restoredFromBackup: false, removedStaleServer: true };
}

export async function provisionGeminiGoalMcp(input: {
  workspaceRoot: string;
  launch?: GoalHostMcpLaunch;
}): Promise<GeminiGoalMcpProvisionResult> {
  const ownerToken = randomUUID();
  const launch = input.launch ?? buildGoalHostMcpLaunch();
  // Lock first so concurrent Aroko turns cannot race reconcile/mutate.
  await acquireLock(input.workspaceRoot, ownerToken);
  try {
    await reconcileStaleGeminiGoalMcp(input.workspaceRoot);
  } catch (error) {
    await releaseLock(input.workspaceRoot, ownerToken);
    throw error;
  }

  const path = settingsPath(input.workspaceRoot);
  let priorRaw = "";
  let priorHash = "";
  let createdSettingsDir = false;
  try {
    await mkdir(dirname(path), { recursive: true });
    createdSettingsDir = true;
  } catch {
    // exists
  }

  try {
    priorRaw = await readFile(path, "utf8");
    priorHash = sha256(priorRaw);
  } catch {
    priorRaw = "";
    priorHash = "";
  }

  let backupFile: string | null = null;
  if (priorRaw) {
    backupFile = backupPath(input.workspaceRoot, ownerToken);
    await writeFile(backupFile, priorRaw, "utf8");
  } else {
    // Marker file representing "no prior settings"
    backupFile = backupPath(input.workspaceRoot, ownerToken);
    await writeFile(backupFile, "", "utf8");
  }

  let root: Record<string, unknown> = {};
  if (priorRaw.trim()) {
    try {
      const parsed = JSON.parse(priorRaw) as unknown;
      root = asRecord(parsed) ?? {};
    } catch {
      // Preserve unreadable prior file via backup; start a minimal overlay object.
      root = {};
    }
  }

  const servers = { ...(asRecord(root.mcpServers) ?? {}) };
  servers[PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME] = buildGeminiGoalMcpServerEntry(launch, ownerToken);
  root.mcpServers = servers;

  // Narrow allowlist for this turn; restore from backup afterward.
  const mcp = { ...(asRecord(root.mcp) ?? {}) };
  mcp.allowed = [PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME];
  root.mcp = mcp;

  // Defense in depth: hide mutators from discovery for this turn.
  const tools = { ...(asRecord(root.tools) ?? {}) };
  const priorExclude = Array.isArray(tools.exclude)
    ? tools.exclude.filter((entry): entry is string => typeof entry === "string")
    : [];
  tools.exclude = [...new Set([...priorExclude, ...GEMINI_GOAL_EXCLUDED_TOOLS])];
  root.tools = tools;

  const security = { ...(asRecord(root.security) ?? {}) };
  security.disableYoloMode = true;
  root.security = security;

  const next = `${JSON.stringify(root, null, 2)}\n`;
  const tmp = `${path}.pairmesh-tmp-${ownerToken}`;
  try {
    await writeFile(tmp, next, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if (backupFile) {
      const backup = await readFile(backupFile, "utf8").catch(() => "");
      if (backup.length === 0) {
        await rm(path, { force: true }).catch(() => undefined);
      } else {
        await writeFile(path, backup, "utf8").catch(() => undefined);
      }
      await rm(backupFile, { force: true }).catch(() => undefined);
    }
    await releaseLock(input.workspaceRoot, ownerToken);
    throw error;
  }

  return {
    ownerToken,
    settingsPath: path,
    backupPath: backupFile,
    createdSettingsDir,
    priorHash,
    provisionedHash: sha256(next),
    launch,
    allowedMcpServerNames: [PAIRMESH_GEMINI_GOAL_MCP_SERVER_NAME],
    includeTools: PAIRMESH_GOAL_HOST_TOOLS.map((t) => t.name)
  };
}

export async function restoreGeminiGoalMcp(input: {
  workspaceRoot: string;
  provision: GeminiGoalMcpProvisionResult;
}): Promise<void> {
  const { provision, workspaceRoot } = input;
  try {
    if (provision.backupPath) {
      let current = "";
      try {
        current = await readFile(provision.settingsPath, "utf8");
      } catch {
        current = "";
      }
      const currentHash = current ? sha256(current) : "";
      // Fail closed if another writer changed settings underneath us.
      if (
        currentHash &&
        currentHash !== provision.provisionedHash &&
        currentHash !== provision.priorHash
      ) {
        throw new Error(
          "Gemini settings changed during the Aroko goal turn; refusing to overwrite concurrent edits."
        );
      }
      const backup = await readFile(provision.backupPath, "utf8");
      if (backup.length === 0) {
        // No prior settings — remove file we created.
        await rm(provision.settingsPath, { force: true });
      } else {
        await writeFile(provision.settingsPath, backup, "utf8");
      }
      await rm(provision.backupPath, { force: true });
    }
  } finally {
    await releaseLock(workspaceRoot, provision.ownerToken);
  }
}
