import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendReliabilityMetric,
  buildReliabilitySummary,
  computeDurationMs,
  isSensitiveMetricKey,
  newCorrelationId,
  reliabilityMetricsFilePath,
  RELIABILITY_METRICS_MAX_BYTES,
  resetReliabilityTrackerForTest,
  sanitizeMetricFields,
  summarizeDurations,
  type ReliabilityMetricRecord
} from "./index.js";

describe("Stage 18 Prompt 5 — reliability metrics core", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function workspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pairmesh-rel-"));
    dirs.push(dir);
    return dir;
  }

  it("computes monotonic durations (never negative)", () => {
    expect(computeDurationMs(100, 250)).toBe(150);
    expect(computeDurationMs(250, 100)).toBe(0);
    expect(computeDurationMs(Number.NaN, 1)).toBe(0);
  });

  it("pairs begin/complete with correlation; duplicate complete is ignored", () => {
    let clock = 1_000;
    const emitted: ReliabilityMetricRecord[] = [];
    const tracker = resetReliabilityTrackerForTest({
      now: () => clock,
      emit: (r) => {
        emitted.push(r);
      }
    });
    const corr = newCorrelationId("t");
    const span = tracker.begin("recovery.trigger_to_local_ready", {
      correlationId: corr,
      reason: "pong_timeout",
      transport: "relay"
    });
    clock = 1_842;
    const first = tracker.complete(span.id, { outcome: "success" });
    expect(first?.durationMs).toBe(842);
    expect(first?.correlationId).toBe(corr);
    expect(first?.reason).toBe("pong_timeout");
    expect(tracker.complete(span.id)).toBeNull();
    expect(emitted).toHaveLength(1);
  });

  it("replaced reconnect aborts prior span without success", () => {
    let clock = 0;
    const emitted: ReliabilityMetricRecord[] = [];
    const tracker = resetReliabilityTrackerForTest({
      now: () => clock,
      emit: (r) => emitted.push(r)
    });
    tracker.begin("recovery.trigger_to_local_ready", {
      correlationId: "c1",
      reason: "ws_disconnect",
      replacePrior: true
    });
    clock = 50;
    tracker.begin("recovery.trigger_to_local_ready", {
      correlationId: "c2",
      reason: "pong_timeout",
      replacePrior: true
    });
    clock = 200;
    tracker.completeActive("recovery.trigger_to_local_ready", {
      outcome: "success",
      correlationId: "c2"
    });
    expect(emitted.map((e) => e.outcome)).toEqual(["aborted", "success"]);
    expect(emitted[0]?.reason).toBe("replaced");
    expect(emitted[1]?.reason).toBe("pong_timeout");
    expect(emitted[1]?.durationMs).toBe(150);
  });

  it("keeps reconnect reasons distinguishable", () => {
    const tracker = resetReliabilityTrackerForTest({
      now: (() => {
        let t = 0;
        return () => {
          t += 10;
          return t;
        };
      })(),
      emit: () => undefined
    });
    for (const reason of [
      "pong_timeout",
      "suspension_gap",
      "network_restored",
      "ws_disconnect",
      "explicit"
    ] as const) {
      const span = tracker.begin("recovery.trigger_to_local_ready", {
        reason,
        replacePrior: true
      });
      const record = tracker.complete(span.id, { outcome: "success" });
      expect(record?.reason).toBe(reason);
    }
  });

  it("local-ready and peer-ready are separate metrics", () => {
    const emitted: ReliabilityMetricRecord[] = [];
    const tracker = resetReliabilityTrackerForTest({
      now: () => 100,
      emit: (r) => emitted.push(r)
    });
    const corr = "rec_abc";
    const local = tracker.begin("recovery.trigger_to_local_ready", { correlationId: corr });
    const peer = tracker.begin("recovery.trigger_to_peer_ready", { correlationId: corr });
    tracker.complete(local.id, { outcome: "success" });
    tracker.complete(peer.id, { outcome: "success" });
    expect(emitted.map((e) => e.metric)).toEqual([
      "recovery.trigger_to_local_ready",
      "recovery.trigger_to_peer_ready"
    ]);
  });

  it("shutdown does not emit successful recovery", () => {
    const emitted: ReliabilityMetricRecord[] = [];
    const tracker = resetReliabilityTrackerForTest({
      now: () => 1,
      emit: (r) => emitted.push(r)
    });
    tracker.begin("recovery.trigger_to_local_ready", { reason: "ws_disconnect" });
    tracker.markStopped();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.outcome).toBe("aborted");
    expect(emitted[0]?.reason).toBe("shutdown");
  });

  it("rejects sensitive fields and absolute paths from serialization helpers", () => {
    expect(isSensitiveMetricKey("controlToken")).toBe(true);
    expect(isSensitiveMetricKey("durationMs")).toBe(false);
    const sanitized = sanitizeMetricFields({
      metric: "request.delivery",
      controlToken: "secret",
      path: "/Users/me/project",
      durationMs: 12
    });
    expect(sanitized.controlToken).toBeUndefined();
    expect(sanitized.path).toBeUndefined();
    expect(sanitized.durationMs).toBe(12);
  });

  it("rotates reliability-metrics.jsonl when oversized", async () => {
    const ws = await workspace();
    const path = reliabilityMetricsFilePath(ws);
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "x".repeat(RELIABILITY_METRICS_MAX_BYTES), "utf8");
    await appendReliabilityMetric(ws, {
      v: 1,
      metric: "request.delivery",
      durationMs: 1,
      outcome: "success",
      correlationId: "c",
      timestamp: new Date().toISOString(),
      buildId: "test"
    });
    const size = (await stat(path)).size;
    expect(size).toBeLessThan(RELIABILITY_METRICS_MAX_BYTES);
    // Rotated content preserved; active file recreated empty after rotate.
    const { readFile } = await import("node:fs/promises");
    const rotated = await readFile(`${path}.1`, "utf8");
    expect(rotated.length).toBeGreaterThanOrEqual(RELIABILITY_METRICS_MAX_BYTES);
  });

  it("summarizes tiny samples as preliminary without pretending p95", () => {
    const stats = summarizeDurations([10, 20, 30]);
    expect(stats.count).toBe(3);
    expect(stats.median).toBe(20);
    expect(stats.preliminary).toBe(true);
    expect(stats.p95).toBeUndefined();
    const big = summarizeDurations(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(big.preliminary).toBe(false);
    expect(big.p95).toBeDefined();
  });

  it("builds compact doctor/control summary", () => {
    const summary = buildReliabilitySummary([
      {
        v: 1,
        metric: "recovery.trigger_to_local_ready",
        durationMs: 1800,
        outcome: "success",
        correlationId: "a",
        reason: "network_restored",
        timestamp: new Date().toISOString(),
        buildId: "b"
      },
      {
        v: 1,
        metric: "recovery.trigger_to_peer_ready",
        durationMs: 2400,
        outcome: "success",
        correlationId: "a",
        timestamp: new Date().toISOString(),
        buildId: "b"
      }
    ]);
    expect(summary.lastReconnect?.durationMs).toBe(1800);
    expect(summary.lastReconnect?.reason).toBe("network_restored");
    expect(summary.lastPeerRecovery?.durationMs).toBe(2400);
  });

  it("upgrade timing is independent of busy-wait (no span until restart begins)", () => {
    const emitted: ReliabilityMetricRecord[] = [];
    const tracker = resetReliabilityTrackerForTest({
      now: () => 500,
      emit: (r) => emitted.push(r)
    });
    // Busy deferral must not open upgrade_to_ready.
    expect(tracker.findOpen("runtime.upgrade_to_ready")).toBeUndefined();
    const span = tracker.begin("runtime.upgrade_to_ready", {
      phase: "restart_begin",
      reason: "build_mismatch"
    });
    tracker.complete(span.id, { outcome: "success", phase: "build_match" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.phase).toBe("build_match");
  });
});
