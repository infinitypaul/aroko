import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PairMeshRuntimeInfoSchema, type PairMeshRuntimeInfo } from "./schema.js";
import { runtimeFilePath } from "./paths.js";

export async function readRuntimeInfo(workspace: string): Promise<PairMeshRuntimeInfo | null> {
  try {
    const raw = await readFile(runtimeFilePath(workspace), "utf8");
    return PairMeshRuntimeInfoSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeRuntimeInfo(
  workspace: string,
  info: PairMeshRuntimeInfo
): Promise<void> {
  const path = runtimeFilePath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(PairMeshRuntimeInfoSchema.parse(info), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export async function clearRuntimeInfo(workspace: string): Promise<void> {
  await rm(runtimeFilePath(workspace), { force: true });
}

export async function isRuntimeProcessAlive(info: PairMeshRuntimeInfo): Promise<boolean> {
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}
