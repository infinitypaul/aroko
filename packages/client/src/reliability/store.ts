
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { reliabilityMetricsFilePath } from "../local-config/paths.js";
import { STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "../state/store.js";
import { sanitizeMetricFields, type ReliabilityMetricRecord } from "./types.js";

export { reliabilityMetricsFilePath } from "../local-config/paths.js";

/** Rotate active file above this size. */
export const RELIABILITY_METRICS_MAX_BYTES = 512 * 1024;
/** Keep this many rotated files plus the active file. */
export const RELIABILITY_METRICS_KEEP = 2;
/** Soft cap on in-memory recent summary window. */
export const RELIABILITY_RECENT_LIMIT = 40;

export async function appendReliabilityMetric(
  workspace: string,
  record: ReliabilityMetricRecord
): Promise<void> {
  const path = reliabilityMetricsFilePath(workspace);
  await mkdir(dirname(path), { recursive: true, mode: STATE_DIRECTORY_MODE });
  const safe = sanitizeMetricFields(record as unknown as Record<string, unknown>);
  const line = `${JSON.stringify({ ...safe, v: 1 })}\n`;
  await appendFile(path, line, { encoding: "utf8", mode: STATE_FILE_MODE });
  await maybeRotateReliabilityMetrics(workspace);
}

async function maybeRotateReliabilityMetrics(workspace: string): Promise<void> {
  const path = reliabilityMetricsFilePath(workspace);
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return;
  }
  if (size < RELIABILITY_METRICS_MAX_BYTES) {
    return;
  }
  const rotated = `${path}.1`;
  try {
    await rm(`${path}.2`, { force: true });
  } catch {
    /* ignore */
  }
  try {
    await rename(rotated, `${path}.2`);
  } catch {
    /* no .1 yet */
  }
  try {
    await rename(path, rotated);
  } catch {
    /* race */
  }
  // Recreate empty active file so subsequent appends and readers have a stable path.
  try {
    await writeFile(path, "", { encoding: "utf8", mode: STATE_FILE_MODE });
  } catch {
    /* ignore */
  }
}

export async function readReliabilityMetrics(
  workspace: string,
  limit = RELIABILITY_RECENT_LIMIT
): Promise<ReliabilityMetricRecord[]> {
  const path = reliabilityMetricsFilePath(workspace);
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const sliced = lines.slice(-Math.max(1, limit));
  const out: ReliabilityMetricRecord[] = [];
  for (const line of sliced) {
    try {
      const parsed = JSON.parse(line) as ReliabilityMetricRecord;
      if (parsed?.v === 1 && typeof parsed.metric === "string") {
        out.push(parsed);
      }
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export async function writeReliabilityMetricsForTest(
  workspace: string,
  records: ReliabilityMetricRecord[]
): Promise<void> {
  const path = reliabilityMetricsFilePath(workspace);
  await mkdir(dirname(path), { recursive: true, mode: STATE_DIRECTORY_MODE });
  await writeFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""), {
    encoding: "utf8",
    mode: STATE_FILE_MODE
  });
}
