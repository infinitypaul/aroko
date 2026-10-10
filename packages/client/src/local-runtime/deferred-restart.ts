
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as z from "zod";
import { deferredRestartFilePath } from "../local-config/paths.js";
import { STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "../state/store.js";

const DeferredRestartSchema = z.strictObject({
  version: z.literal(1),
  targetBuildId: z.string().trim().min(1),
  targetVersion: z.string().trim().min(1).optional(),
  requestedAt: z.string().datetime(),
  reason: z.string().trim().min(1).max(400)
});

export type DeferredRestartIntent = z.infer<typeof DeferredRestartSchema>;

export async function readDeferredRestart(
  workspace: string
): Promise<DeferredRestartIntent | null> {
  try {
    const raw = await readFile(deferredRestartFilePath(workspace), "utf8");
    return DeferredRestartSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeDeferredRestart(
  workspace: string,
  intent: Omit<DeferredRestartIntent, "version"> & { version?: 1 }
): Promise<DeferredRestartIntent> {
  const validated = DeferredRestartSchema.parse({
    version: 1,
    ...intent
  });
  const path = deferredRestartFilePath(workspace);
  await mkdir(dirname(path), { recursive: true, mode: STATE_DIRECTORY_MODE });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: STATE_FILE_MODE
  });
  return validated;
}

export async function clearDeferredRestart(workspace: string): Promise<void> {
  await rm(deferredRestartFilePath(workspace), { force: true });
}
