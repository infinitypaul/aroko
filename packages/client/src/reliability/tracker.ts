
import { PAIRMESH_BUILD_ID } from "../build-info.js";
import { appendReliabilityMetric } from "./store.js";
import {
  computeDurationMs,
  defaultMonotonicNowMs,
  newCorrelationId,
  type MonotonicNow,
  type ReliabilityMetricName,
  type ReliabilityMetricRecord,
  type ReliabilityOutcome,
  type ReliabilitySpan,
  type ReliabilityTransport
} from "./types.js";

export type ReliabilityEmit = (record: ReliabilityMetricRecord) => void | Promise<void>;

export interface ReliabilityTrackerOptions {
  workspace?: string;
  buildId?: string;
  now?: MonotonicNow;
  emit?: ReliabilityEmit;
}

export class ReliabilityTracker {
  private readonly spans = new Map<string, ReliabilitySpan>();
  private readonly completedIds = new Set<string>();
  private readonly recent: ReliabilityMetricRecord[] = [];
  private workspace?: string;
  private buildId: string;
  private readonly now: MonotonicNow;
  private readonly emitFn?: ReliabilityEmit;
  private stopped = false;

  public constructor(options: ReliabilityTrackerOptions = {}) {
    this.workspace = options.workspace;
    this.buildId = options.buildId ?? PAIRMESH_BUILD_ID;
    this.now = options.now ?? defaultMonotonicNowMs;
    this.emitFn = options.emit;
  }

  public configure(options: { workspace?: string; buildId?: string }): void {
    if (options.workspace) {
      this.workspace = options.workspace;
    }
    if (options.buildId) {
      this.buildId = options.buildId;
    }
  }

  public markStopped(): void {
    this.stopped = true;
    for (const span of this.spans.values()) {
      if (!span.completed) {
        this.abort(span.id, "shutdown");
      }
    }
  }

  public begin(
    metric: ReliabilityMetricName,
    options: {
      correlationId?: string;
      transport?: ReliabilityTransport;
      reason?: string;
      phase?: string;
      /** When true, replace any prior open span for this metric (no success emit). */
      replacePrior?: boolean;
    } = {}
  ): ReliabilitySpan {
    if (options.replacePrior) {
      for (const existing of this.spans.values()) {
        if (!existing.completed && existing.metric === metric) {
          this.abort(existing.id, "replaced");
        }
      }
    }
    const span: ReliabilitySpan = {
      id: newCorrelationId("s"),
      metric,
      correlationId: options.correlationId ?? newCorrelationId("c"),
      startMonoMs: this.now(),
      transport: options.transport,
      reason: options.reason,
      phase: options.phase,
      completed: false
    };
    this.spans.set(span.id, span);
    return span;
  }

  public completeActive(
    metric: ReliabilityMetricName,
    options: {
      outcome?: ReliabilityOutcome;
      reason?: string;
      phase?: string;
      correlationId?: string;
    } = {}
  ): ReliabilityMetricRecord | null {
    for (const span of this.spans.values()) {
      if (span.completed || span.metric !== metric) {
        continue;
      }
      if (options.correlationId && span.correlationId !== options.correlationId) {
        continue;
      }
      return this.complete(span.id, options);
    }
    return null;
  }

  public findOpen(
    metric: ReliabilityMetricName,
    correlationId?: string
  ): ReliabilitySpan | undefined {
    for (const span of this.spans.values()) {
      if (span.completed || span.metric !== metric) {
        continue;
      }
      if (correlationId && span.correlationId !== correlationId) {
        continue;
      }
      return span;
    }
    return undefined;
  }

  /**
   * Abort an in-flight span of the same metric+correlation (replaced reconnect).
   * Does not emit success.
   */
  public abortOpen(
    metric: ReliabilityMetricName,
    correlationId: string,
    reason = "replaced"
  ): void {
    for (const span of this.spans.values()) {
      if (!span.completed && span.metric === metric && span.correlationId === correlationId) {
        this.abort(span.id, reason);
      }
    }
  }

  public complete(
    spanId: string,
    options: {
      outcome?: ReliabilityOutcome;
      reason?: string;
      phase?: string;
    } = {}
  ): ReliabilityMetricRecord | null {
    if (this.completedIds.has(spanId)) {
      return null;
    }
    const span = this.spans.get(spanId);
    if (!span || span.completed) {
      return null;
    }
    const outcome = options.outcome ?? "success";
    if (this.stopped && outcome === "success") {
      return this.abort(spanId, "shutdown");
    }
    span.completed = true;
    this.completedIds.add(spanId);
    this.spans.delete(spanId);

    const durationMs = computeDurationMs(span.startMonoMs, this.now());
    const record: ReliabilityMetricRecord = {
      v: 1,
      metric: span.metric,
      durationMs,
      outcome,
      correlationId: span.correlationId,
      timestamp: new Date().toISOString(),
      buildId: this.buildId,
      ...(span.transport ? { transport: span.transport } : {}),
      ...((options.reason ?? span.reason) ? { reason: options.reason ?? span.reason } : {}),
      ...((options.phase ?? span.phase) ? { phase: options.phase ?? span.phase } : {})
    };
    this.pushRecent(record);
    void this.persist(record);
    return record;
  }

  public abort(spanId: string, reason = "aborted"): ReliabilityMetricRecord | null {
    return this.complete(spanId, { outcome: "aborted", reason });
  }

  public getRecent(limit = 20): ReliabilityMetricRecord[] {
    return this.recent.slice(-limit);
  }

  public getLatestSuccess(metric: ReliabilityMetricName): ReliabilityMetricRecord | undefined {
    for (let i = this.recent.length - 1; i >= 0; i -= 1) {
      const row = this.recent[i]!;
      if (row.metric === metric && row.outcome === "success") {
        return row;
      }
    }
    return undefined;
  }

  private pushRecent(record: ReliabilityMetricRecord): void {
    this.recent.push(record);
    if (this.recent.length > 80) {
      this.recent.splice(0, this.recent.length - 80);
    }
  }

  private async persist(record: ReliabilityMetricRecord): Promise<void> {
    if (this.emitFn) {
      await this.emitFn(record);
      return;
    }
    if (!this.workspace) {
      return;
    }
    try {
      await appendReliabilityMetric(this.workspace, record);
    } catch {
      /* diagnostics must not break runtime */
    }
  }
}

let sharedTracker: ReliabilityTracker | null = null;

export function getReliabilityTracker(): ReliabilityTracker {
  if (!sharedTracker) {
    sharedTracker = new ReliabilityTracker();
  }
  return sharedTracker;
}

export function resetReliabilityTrackerForTest(
  options?: ReliabilityTrackerOptions
): ReliabilityTracker {
  sharedTracker = new ReliabilityTracker(options ?? {});
  return sharedTracker;
}

export function configureReliabilityTracker(options: {
  workspace?: string;
  buildId?: string;
}): void {
  getReliabilityTracker().configure(options);
}
