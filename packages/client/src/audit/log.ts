import {
  PAIRMESH_AUDIT_VERSION,
  PairMeshAuditEventSchema,
  IsoUtcTimestampSchema,
  AuditEventIdSchema,
  createPairMeshError,
  type AuditAuthFailureReason,
  type AuditDirection,
  type AuditEventType,
  type PairMeshAuditEvent,
  type PairMeshSourceReference
} from "@pairmesh/protocol";
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "../state/store.js";
import { auditEventsFileFromStateFile } from "../local-config/paths.js";

/** Rotate the active JSONL file when it exceeds this size (2 MiB). */
export const AUDIT_ROTATE_MAX_BYTES = 2 * 1024 * 1024;
/** Keep this many rotated `events.N.jsonl` files plus the active file. */
export const AUDIT_ROTATE_KEEP = 3;

export type AuditHealthStatus = "ready" | "degraded" | "missing";

export interface AuditHealth {
  status: AuditHealthStatus;
  reason?: string;
  eventsFile?: string;
}

export interface AuditLogOptions {
  /** Absolute path to `events.jsonl`. Derived from state file when omitted. */
  eventsFilePath?: string;
  stateFilePath?: string;
  maxBytes?: number;
  keepRotated?: number;
}

/**
 * Append-only, allow-listed JSONL audit writer. Callers pass typed event
 * builders only — never arbitrary request/response objects.
 */
export class AuditLog {
  public readonly eventsFilePath: string;
  public readonly auditDir: string;
  private readonly maxBytes: number;
  private readonly keepRotated: number;
  private lastFailureReason?: string;
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(options: AuditLogOptions = {}) {
    this.eventsFilePath =
      options.eventsFilePath ??
      (options.stateFilePath
        ? auditEventsFileFromStateFile(options.stateFilePath)
        : join(process.cwd(), ".pairmesh", "audit", "events.jsonl"));
    this.auditDir = dirname(this.eventsFilePath);
    this.maxBytes = options.maxBytes ?? AUDIT_ROTATE_MAX_BYTES;
    this.keepRotated = options.keepRotated ?? AUDIT_ROTATE_KEEP;
  }

  public static fromStateFile(stateFilePath: string): AuditLog {
    return new AuditLog({ stateFilePath });
  }

  public getHealth(): AuditHealth {
    if (this.lastFailureReason) {
      return {
        status: "degraded",
        reason: "Unable to append local audit records.",
        eventsFile: this.eventsFilePath
      };
    }
    return { status: "ready", eventsFile: this.eventsFilePath };
  }

  /**
   * Persist one validated event. Failures are recorded for doctor and never
   * thrown to callers — collaboration must not depend on audit I/O.
   */
  public record(event: PairMeshAuditEvent): void {
    const validated = PairMeshAuditEventSchema.safeParse(event);
    if (!validated.success) {
      this.lastFailureReason = "invalid_event";
      return;
    }

    this.writeChain = this.writeChain
      .then(async () => {
        await this.appendValidated(validated.data);
        this.lastFailureReason = undefined;
      })
      .catch((error: unknown) => {
        this.lastFailureReason =
          error instanceof Error ? error.message.slice(0, 120) : "audit_write_failed";
      });
  }

  /** Await pending writes (tests / shutdown). */
  public async flush(): Promise<void> {
    await this.writeChain;
  }

  public async readRecent(limit = 50): Promise<PairMeshAuditEvent[]> {
    const lines = await this.readAllLinesNewestFirst();
    const events: PairMeshAuditEvent[] = [];
    for (const line of lines) {
      if (events.length >= limit) {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = PairMeshAuditEventSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) {
          events.push(parsed.data);
        }
      } catch {
        // Skip malformed historical lines.
      }
    }
    return events;
  }

  private async appendValidated(event: PairMeshAuditEvent): Promise<void> {
    await mkdir(this.auditDir, { recursive: true, mode: STATE_DIRECTORY_MODE });
    await restrictMode(this.auditDir, STATE_DIRECTORY_MODE);
    await this.rotateIfNeeded();

    const line = `${JSON.stringify(event)}\n`;
    await appendFile(this.eventsFilePath, line, { encoding: "utf8", mode: STATE_FILE_MODE });
    await restrictMode(this.eventsFilePath, STATE_FILE_MODE);
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.eventsFilePath)).size;
    } catch (error) {
      if (isEnoent(error)) {
        return;
      }
      throw error;
    }
    if (size < this.maxBytes) {
      return;
    }

    for (let index = this.keepRotated; index >= 1; index -= 1) {
      const from = index === 1 ? this.eventsFilePath : `${this.eventsFilePath}.${index - 1}`;
      const to = `${this.eventsFilePath}.${index}`;
      try {
        await rename(from, to);
        await restrictMode(to, STATE_FILE_MODE);
      } catch (error) {
        if (!isEnoent(error)) {
          throw error;
        }
      }
    }
  }

  private async readAllLinesNewestFirst(): Promise<string[]> {
    const files = [this.eventsFilePath];
    for (let index = 1; index <= this.keepRotated; index += 1) {
      files.push(`${this.eventsFilePath}.${index}`);
    }

    const newestFirst: string[] = [];
    for (const file of files) {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (isEnoent(error)) {
          continue;
        }
        throw error;
      }
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      newestFirst.push(...lines.reverse());
    }
    return newestFirst;
  }
}

export function createAuditEventId(): string {
  return AuditEventIdSchema.parse(`aud_${randomUUID()}`);
}

export function nowAuditTimestamp(): string {
  return IsoUtcTimestampSchema.parse(new Date().toISOString());
}

export interface BuildAuditEventInput {
  eventType: AuditEventType;
  projectId?: string;
  sessionId?: string;
  sessionCode?: string;
  actor?: PairMeshAuditEvent["actor"];
  target?: PairMeshAuditEvent["target"];
  correlation?: PairMeshAuditEvent["correlation"];
  metadata: Record<string, unknown>;
}

export function buildAuditEvent(input: BuildAuditEventInput): PairMeshAuditEvent {
  return PairMeshAuditEventSchema.parse({
    version: PAIRMESH_AUDIT_VERSION,
    eventId: createAuditEventId(),
    timestamp: nowAuditTimestamp(),
    eventType: input.eventType,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.sessionCode ? { sessionCode: input.sessionCode } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(input.correlation ? { correlation: input.correlation } : {}),
    metadata: input.metadata
  });
}

export function buildResultSharedMetadata(input: {
  direction: AuditDirection;
  summary?: string;
  findings?: string[];
  references?: PairMeshSourceReference[];
}): {
  direction: AuditDirection;
  summaryPresent: boolean;
  findingCount: number;
  referenceCount: number;
  referencedFiles: string[];
  referencedSymbols?: string[];
} {
  const files = new Set<string>();
  const symbols = new Set<string>();
  for (const reference of input.references ?? []) {
    if (reference.file) {
      files.add(reference.file);
    }
    if (reference.symbol) {
      symbols.add(reference.symbol);
    }
  }
  return {
    direction: input.direction,
    summaryPresent: Boolean(input.summary && input.summary.trim().length > 0),
    findingCount: input.findings?.length ?? 0,
    referenceCount: Math.min(input.references?.length ?? 0, 50),
    referencedFiles: [...files].slice(0, 50),
    ...(symbols.size > 0 ? { referencedSymbols: [...symbols].slice(0, 50) } : {})
  };
}

export function mapAuthFailureReason(code?: string): AuditAuthFailureReason {
  switch (code) {
    case "pairmesh.authentication_required":
      return "missing_credential";
    case "pairmesh.peer_revoked":
      return "revoked_credential";
    case "pairmesh.authentication_failed":
      return "unknown_bearer";
    case "pairmesh.session_requires_repair":
      return "session_mismatch";
    default:
      return code?.includes("unknown") ? "unknown_bearer" : "other";
  }
}

async function restrictMode(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, mode);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "Failed to set PairMesh audit file permissions."
    });
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function formatAuditEventHuman(event: PairMeshAuditEvent): string {
  const when = event.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const label = event.eventType.replace(/\./g, " ");
  const lines = [`${when}  ${label}`];

  const actorName = event.actor?.peerName;
  const targetName = event.target?.peerName;
  if (actorName && targetName) {
    lines.push(`  ${actorName} → ${targetName}`);
  } else if (actorName) {
    lines.push(`  ${actorName}`);
  } else if (targetName) {
    lines.push(`  → ${targetName}`);
  }

  if (event.correlation?.requestId) {
    lines.push(`  request ${event.correlation.requestId}`);
  }
  if (event.correlation?.threadId) {
    lines.push(`  thread ${event.correlation.threadId}`);
  }

  // Zod discriminated-union narrowing is unreliable across package boundaries for
  // metadata; narrow with explicit eventType checks + typed metadata extracts.
  if (event.eventType === "inspection.result_shared") {
    const meta = event.metadata as {
      referenceCount: number;
      findingCount: number;
      referencedFiles: string[];
    };
    lines.push(
      `  ${meta.referenceCount} source file(s) referenced` +
        (meta.findingCount ? ` · findings ${meta.findingCount}` : "")
    );
    if (meta.referencedFiles.length > 0) {
      lines.push(`  files: ${meta.referencedFiles.join(", ")}`);
    }
  } else if (
    event.eventType === "inspection.completed" ||
    event.eventType === "inspection.failed" ||
    event.eventType === "inspection.cancelled" ||
    event.eventType === "inspection.timed_out" ||
    event.eventType === "inspection.requested" ||
    event.eventType === "inspection.started"
  ) {
    const meta = event.metadata as { durationMs?: number; errorCode?: string };
    if (meta.durationMs !== undefined) {
      lines.push(`  duration ${(meta.durationMs / 1000).toFixed(1)}s`);
    }
    if (meta.errorCode) {
      lines.push(`  error ${meta.errorCode}`);
    }
  } else if (event.eventType === "authentication.failed") {
    const meta = event.metadata as { reason: string };
    lines.push(`  reason ${meta.reason}`);
  } else if (
    event.eventType === "permission.requested" ||
    event.eventType === "permission.allowed" ||
    event.eventType === "permission.denied" ||
    event.eventType === "capability.granted" ||
    event.eventType === "capability.revoked"
  ) {
    const meta = event.metadata as {
      capabilityId: string;
      permissionRequestId?: string;
      decision?: string;
      policy?: string;
    };
    lines.push(`  capability ${meta.capabilityId}`);
    if (meta.permissionRequestId) {
      lines.push(`  permission ${meta.permissionRequestId}`);
    }
    if (meta.decision) {
      lines.push(`  decision ${meta.decision}`);
    }
    if (meta.policy) {
      lines.push(`  policy ${meta.policy}`);
    }
  }

  return lines.join("\n");
}
