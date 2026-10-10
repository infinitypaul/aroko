import * as z from "zod";
import { canonicalizeForDigest, sha256Hex } from "../digest.js";
import type { BoundProcessExecution } from "./resolve.js";

export const PROCESS_EXECUTION_FORMAT_V1 = "pairmesh.process_execution.v1" as const;

/** Receiver-safe / peer-visible process execution artifact (no absolute paths). */
export const ProcessExecutionArtifactV1Schema = z.strictObject({
  format: z.literal(PROCESS_EXECUTION_FORMAT_V1),
  schemaVersion: z.literal(1),
  executionMode: z.literal("structured"),
  executableBasename: z.string().trim().min(1).max(80),
  resolvedExecutableIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  args: z.array(z.string().max(500)).max(50),
  cwdRelative: z.string().trim().min(1).max(500),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  envPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  stdinMode: z.literal("closed"),
  maxOutputBytes: z.number().int().min(1_024).max(2_000_000),
  workspaceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: z.string().trim().min(1).max(120).optional(),
  createdAt: z.string().trim().min(1)
});
export type ProcessExecutionArtifactV1 = z.infer<typeof ProcessExecutionArtifactV1Schema>;

export function buildProcessExecutionArtifactBody(input: {
  bound: BoundProcessExecution;
  requestedBy?: string;
  createdAt: string;
}): ProcessExecutionArtifactV1 {
  return ProcessExecutionArtifactV1Schema.parse({
    format: PROCESS_EXECUTION_FORMAT_V1,
    schemaVersion: 1,
    executionMode: "structured",
    executableBasename: input.bound.executableBasename,
    resolvedExecutableIdentity: input.bound.resolved.identity,
    args: [...input.bound.args],
    cwdRelative: input.bound.cwdRelative,
    timeoutMs: input.bound.timeoutMs,
    envPolicyDigest: input.bound.envPolicyDigest,
    stdinMode: "closed",
    maxOutputBytes: input.bound.maxOutputBytes,
    workspaceIdentity: input.bound.workspaceIdentity,
    requestedBy: input.requestedBy,
    createdAt: input.createdAt
  });
}

export function buildCanonicalProcessExecutionBytes(body: ProcessExecutionArtifactV1): Buffer {
  return Buffer.from(canonicalizeForDigest(body), "utf8");
}

export function contentHashProcessExecution(body: ProcessExecutionArtifactV1): string {
  return sha256Hex(buildCanonicalProcessExecutionBytes(body));
}

/** Display-only reconstruction — never used as spawn authority. */
export function formatProcessCommandDisplay(executable: string, args: string[]): string {
  const quote = (value: string): string => {
    if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) {
      return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
  };
  return [executable, ...args.map(quote)].join(" ");
}
