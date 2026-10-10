
import { readReliabilityMetrics } from "./store.js";
import { getReliabilityTracker } from "./tracker.js";
import {
  summarizeDurations,
  type ReliabilityMetricName,
  type ReliabilityMetricRecord
} from "./types.js";

export interface ReliabilitySummaryView {
  lastReconnect?: {
    durationMs: number;
    reason?: string;
  };
  lastPeerRecovery?: {
    durationMs: number;
    reason?: string;
  };
  lastUpgrade?: {
    durationMs: number;
  };
  lastRequestDelivery?: {
    durationMs: number;
  };
  lastPresenceReady?: {
    durationMs: number;
  };
}

function latestSuccess(
  records: ReliabilityMetricRecord[],
  metric: ReliabilityMetricName
): ReliabilityMetricRecord | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const row = records[i]!;
    if (row.metric === metric && row.outcome === "success") {
      return row;
    }
  }
  return undefined;
}

export function buildReliabilitySummary(
  records: ReliabilityMetricRecord[]
): ReliabilitySummaryView {
  const local = latestSuccess(records, "recovery.trigger_to_local_ready");
  const peer = latestSuccess(records, "recovery.trigger_to_peer_ready");
  const upgrade = latestSuccess(records, "runtime.upgrade_to_ready");
  const delivery = latestSuccess(records, "request.delivery");
  const presence = latestSuccess(records, "peer.presence_to_ready");
  return {
    ...(local
      ? {
          lastReconnect: {
            durationMs: local.durationMs,
            ...(local.reason ? { reason: local.reason } : {})
          }
        }
      : {}),
    ...(peer
      ? {
          lastPeerRecovery: {
            durationMs: peer.durationMs,
            ...(peer.reason ? { reason: peer.reason } : {})
          }
        }
      : {}),
    ...(upgrade ? { lastUpgrade: { durationMs: upgrade.durationMs } } : {}),
    ...(delivery ? { lastRequestDelivery: { durationMs: delivery.durationMs } } : {}),
    ...(presence ? { lastPresenceReady: { durationMs: presence.durationMs } } : {})
  };
}

export async function loadReliabilitySummary(workspace: string): Promise<ReliabilitySummaryView> {
  const fromDisk = await readReliabilityMetrics(workspace, 40);
  const fromMemory = getReliabilityTracker().getRecent(40);
  const merged = [...fromDisk, ...fromMemory];
  return buildReliabilitySummary(merged);
}

export function formatReliabilityDoctorLines(summary: ReliabilitySummaryView): string[] {
  const lines: string[] = [];
  if (summary.lastReconnect) {
    const reason = summary.lastReconnect.reason ? ` (${summary.lastReconnect.reason})` : "";
    lines.push(`Last reconnect: ${(summary.lastReconnect.durationMs / 1000).toFixed(1)}s${reason}`);
  }
  if (summary.lastPeerRecovery) {
    lines.push(`Last peer recovery: ${(summary.lastPeerRecovery.durationMs / 1000).toFixed(1)}s`);
  }
  if (summary.lastUpgrade) {
    lines.push(`Last upgrade restart: ${(summary.lastUpgrade.durationMs / 1000).toFixed(1)}s`);
  }
  if (summary.lastRequestDelivery) {
    lines.push(`Last request delivery: ${Math.round(summary.lastRequestDelivery.durationMs)}ms`);
  }
  if (summary.lastPresenceReady) {
    lines.push(`Last presence→ready: ${Math.round(summary.lastPresenceReady.durationMs)}ms`);
  }
  return lines;
}

export function summarizeMetricSamples(
  records: ReliabilityMetricRecord[],
  metric: ReliabilityMetricName
): ReturnType<typeof summarizeDurations> {
  const samples = records
    .filter((r) => r.metric === metric && r.outcome === "success")
    .map((r) => r.durationMs);
  return summarizeDurations(samples);
}
