import { createPairMeshError, type ActionId } from "@pairmesh/protocol";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "../../state/store.js";

export type ProcessSpawnJournalPhase = "spawn_committed" | "completed";

export interface ProcessSpawnJournal {
  actionId: ActionId;
  phase: ProcessSpawnJournalPhase;
  updatedAt: string;
}

function journalPath(actionsRoot: string, actionId: ActionId): string {
  return join(actionsRoot, ".process-spawn-journal", `${actionId}.json`);
}

export async function writeProcessSpawnJournal(
  actionsRoot: string,
  entry: ProcessSpawnJournal
): Promise<void> {
  const absolute = journalPath(actionsRoot, entry.actionId);
  await mkdir(join(actionsRoot, ".process-spawn-journal"), {
    recursive: true,
    mode: STATE_DIRECTORY_MODE
  });
  const temp = `${absolute}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(entry, null, 2)}\n`;
  await writeFile(temp, payload, { flag: "w", mode: STATE_FILE_MODE });
  await rename(temp, absolute);
}

export async function readProcessSpawnJournal(
  actionsRoot: string,
  actionId: ActionId
): Promise<ProcessSpawnJournal | null> {
  try {
    const raw = await readFile(journalPath(actionsRoot, actionId), "utf8");
    const parsed = JSON.parse(raw) as ProcessSpawnJournal;
    if (parsed.actionId !== actionId) {
      throw createPairMeshError({
        code: "pairmesh.internal_error",
        message: "Process spawn journal actionId mismatch."
      });
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
