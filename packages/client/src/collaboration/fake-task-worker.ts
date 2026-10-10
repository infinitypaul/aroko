import type { TaskWorkerEnvelope } from "@pairmesh/protocol";
import type { TaskWorker, TaskWorkerTurnResult } from "./continuation-orchestrator.js";

export interface FakeTaskWorkerTurnContext {
  instanceId: string;
  turnIndex: number;
}

export type FakeTaskWorkerScriptEntry =
  | TaskWorkerTurnResult
  | {
      continuationSeq?: number;
      kind?: "first_turn" | "continuation";
      result: TaskWorkerTurnResult;
    };

export interface FakeTaskWorkerOptions {
  /** Stable id so tests can prove a new process instance continued the same task. */
  instanceId?: string;
  /** Ordered and/or keyed script of turn behaviors. */
  script?: FakeTaskWorkerScriptEntry[];
  /** Dynamic turn handler — preferred when provided. */
  onTurn?: (
    envelope: TaskWorkerEnvelope,
    ctx: FakeTaskWorkerTurnContext
  ) => TaskWorkerTurnResult | Promise<TaskWorkerTurnResult>;
}

function isKeyedEntry(entry: FakeTaskWorkerScriptEntry): entry is {
  continuationSeq?: number;
  kind?: "first_turn" | "continuation";
  result: TaskWorkerTurnResult;
} {
  return typeof entry === "object" && entry !== null && "result" in entry && "kind" in entry
    ? true
    : typeof entry === "object" &&
        entry !== null &&
        "result" in entry &&
        ("continuationSeq" in entry || "kind" in entry);
}

/**
 * Provider-neutral Fake worker for R5-5 orchestration tests.
 * No provider session required.
 */
export class FakeTaskWorker implements TaskWorker {
  public readonly instanceId: string;
  public readonly envelopesReceived: TaskWorkerEnvelope[] = [];
  private readonly script: FakeTaskWorkerScriptEntry[];
  private readonly onTurn?: FakeTaskWorkerOptions["onTurn"];
  private readonly usedKeyed = new Set<number>();
  private scriptCursor = 0;
  private turnIndex = 0;

  public constructor(options: FakeTaskWorkerOptions = {}) {
    this.instanceId = options.instanceId ?? "fake-default";
    this.script = options.script ?? [];
    this.onTurn = options.onTurn;
  }

  public async runTurn(envelope: TaskWorkerEnvelope): Promise<TaskWorkerTurnResult> {
    this.envelopesReceived.push(envelope);
    const ctx: FakeTaskWorkerTurnContext = {
      instanceId: this.instanceId,
      turnIndex: this.turnIndex
    };
    this.turnIndex += 1;

    if (this.onTurn) {
      return this.onTurn(envelope, ctx);
    }

    for (let i = 0; i < this.script.length; i += 1) {
      if (this.usedKeyed.has(i)) {
        continue;
      }
      const entry = this.script[i]!;
      if (!isKeyedEntry(entry)) {
        continue;
      }
      const hasKey = entry.continuationSeq !== undefined || entry.kind !== undefined;
      if (!hasKey) {
        continue;
      }
      if (
        entry.continuationSeq !== undefined &&
        entry.continuationSeq !== envelope.continuationSeq
      ) {
        continue;
      }
      if (entry.kind !== undefined && entry.kind !== envelope.kind) {
        continue;
      }
      this.usedKeyed.add(i);
      return entry.result;
    }

    while (this.scriptCursor < this.script.length) {
      const index = this.scriptCursor;
      this.scriptCursor += 1;
      if (this.usedKeyed.has(index)) {
        continue;
      }
      const entry = this.script[index]!;
      if (
        isKeyedEntry(entry) &&
        (entry.continuationSeq !== undefined || entry.kind !== undefined)
      ) {
        continue;
      }
      if (isKeyedEntry(entry)) {
        return entry.result;
      }
      return entry;
    }

    return {
      kind: "completed",
      summary: `FakeTaskWorker ${this.instanceId} completed with no scripted behavior.`
    };
  }
}
