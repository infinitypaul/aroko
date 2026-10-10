import {
  ActionArtifactRecordSchema,
  ArtifactIdSchema,
  createPairMeshError,
  type ActionArtifactRecord,
  type ActionArtifactType,
  type ActionId,
  type ArtifactId
} from "@pairmesh/protocol";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "../state/store.js";

export interface ActionArtifactStoreOptions {
  stateFilePath: string;
}

export class ActionArtifactStore {
  public readonly rootDir: string;

  public constructor(options: ActionArtifactStoreOptions) {
    this.rootDir = join(dirname(resolve(options.stateFilePath)), "actions");
  }

  public storageKey(actionId: ActionId, artifactId: ArtifactId): string {
    return `${actionId}/${artifactId}.bin`;
  }

  public absolutePathForKey(storageKey: string): string {
    const root = resolve(this.rootDir);
    const absolute = resolve(this.rootDir, storageKey);
    if (absolute !== root && !absolute.startsWith(`${root}/`)) {
      throw createPairMeshError({
        code: "pairmesh.boundary_violation",
        message: "Artifact path escapes PairMesh action storage."
      });
    }
    return absolute;
  }

  public async createFinalizedArtifact(input: {
    actionId: ActionId;
    artifactType: ActionArtifactType;
    bytes: Buffer;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<ActionArtifactRecord> {
    await mkdir(this.rootDir, { recursive: true, mode: STATE_DIRECTORY_MODE });
    const artifactId = ArtifactIdSchema.parse(`art_${randomUUID()}`);
    const contentHash = createHash("sha256").update(input.bytes).digest("hex");
    const storageKey = this.storageKey(input.actionId, artifactId);
    const absolute = this.absolutePathForKey(storageKey);
    await mkdir(dirname(absolute), { recursive: true, mode: STATE_DIRECTORY_MODE });

    const tempPath = `${absolute}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, input.bytes, { flag: "wx", mode: STATE_FILE_MODE });
      await chmod(tempPath, STATE_FILE_MODE);
      await rename(tempPath, absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw createPairMeshError({
          code: "pairmesh.artifact_immutable",
          message: "Artifact object already exists and is immutable."
        });
      }
      throw error;
    }
    await chmod(absolute, STATE_FILE_MODE);

    const now = new Date().toISOString();
    return ActionArtifactRecordSchema.parse({
      artifactId,
      actionId: input.actionId,
      artifactType: input.artifactType,
      contentHash,
      byteSize: input.bytes.byteLength,
      createdAt: now,
      finalizedAt: now,
      metadata: input.metadata,
      storageKey
    });
  }

  public async readBytes(record: ActionArtifactRecord): Promise<Buffer> {
    const bytes = await readFile(this.absolutePathForKey(record.storageKey));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== record.contentHash) {
      throw createPairMeshError({
        code: "pairmesh.artifact_hash_mismatch",
        message: "Stored artifact bytes do not match the recorded content hash."
      });
    }
    return bytes;
  }

  public async rejectOverwrite(record: ActionArtifactRecord): Promise<void> {
    try {
      await writeFile(this.absolutePathForKey(record.storageKey), Buffer.from("tamper"), {
        flag: "wx"
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw createPairMeshError({
          code: "pairmesh.artifact_immutable",
          message: "Finalized artifacts cannot be overwritten."
        });
      }
      throw error;
    }
  }
}
