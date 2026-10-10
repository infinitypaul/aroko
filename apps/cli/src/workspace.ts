import { resolvePairMeshProjectRoot, resolveInitWorkspace } from "@pairmesh/client";
import { resolve } from "node:path";

export async function resolveCommandWorkspace(input: string | undefined): Promise<string> {
  return resolvePairMeshProjectRoot({ explicitWorkspace: input });
}

export function resolveInitWorkspacePath(input: string | undefined): string {
  return resolveInitWorkspace(input);
}

/** @deprecated use resolveCommandWorkspace */
export function resolveWorkspacePath(input: string | undefined): string {
  const value = input?.trim() || ".";
  if (value === ".") {
    return resolve(process.cwd());
  }
  return resolve(value);
}
