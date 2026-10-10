import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readBrandedEnv } from "@pairmesh/shared";

export const PAIRMESH_DIR_NAME = ".pairmesh";
export const AROKO_DIR_NAME = PAIRMESH_DIR_NAME;

/**
 * Product home directory. Storage remains ~/.pairmesh.
 * AROKO_HOME aliases PAIRMESH_HOME to the same path (never forks state).
 */
export function getPairMeshHome(): string {
  return getArokoHome();
}

export function getArokoHome(): string {
  const override = readBrandedEnv({
    aroko: "AROKO_HOME",
    pairmesh: "PAIRMESH_HOME",
    warnOnConflict: true
  });
  return override || join(homedir(), ".pairmesh");
}

export function projectPairMeshDir(workspace: string): string {
  return join(resolve(workspace), PAIRMESH_DIR_NAME);
}

export function configFilePath(workspace: string): string {
  return join(projectPairMeshDir(workspace), "config.json");
}

export function stateFilePath(workspace: string): string {
  return join(projectPairMeshDir(workspace), "state.json");
}

export function runtimeFilePath(workspace: string): string {
  return join(projectPairMeshDir(workspace), "runtime.json");
}

export function deferredRestartFilePath(workspace: string): string {
  return join(projectPairMeshDir(workspace), "deferred-restart.json");
}

export function reliabilityMetricsFilePath(workspace: string): string {
  return join(projectPairMeshDir(workspace), "reliability-metrics.jsonl");
}

export function runtimeLogsDir(workspace: string): string {
  return join(projectPairMeshDir(workspace), "logs");
}

export function runtimeLogFilePath(workspace: string): string {
  return join(runtimeLogsDir(workspace), "runtime.log");
}

export function runtimeErrorLogFilePath(workspace: string): string {
  return join(runtimeLogsDir(workspace), "runtime-error.log");
}

export function auditDirPath(workspace: string): string {
  return join(projectPairMeshDir(workspace), "audit");
}

export function auditEventsFilePath(workspace: string): string {
  return join(auditDirPath(workspace), "events.jsonl");
}

export function auditDirFromStateFile(stateFilePath: string): string {
  return join(dirname(resolve(stateFilePath)), "audit");
}

export function auditEventsFileFromStateFile(stateFilePath: string): string {
  return join(auditDirFromStateFile(stateFilePath), "events.jsonl");
}

export async function findProjectConfigFile(startDir: string): Promise<string | null> {
  let current = resolve(startDir);
  const root = resolve("/");

  while (true) {
    const candidate = join(current, PAIRMESH_DIR_NAME, "config.json");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // continue upward
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

export function workspaceBasename(workspace: string): string {
  const normalized = resolve(workspace);
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}
