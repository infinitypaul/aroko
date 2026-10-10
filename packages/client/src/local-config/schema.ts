import { ProjectIdSchema } from "@pairmesh/protocol";
import * as z from "zod";

export const PAIRMESH_LOCAL_CONFIG_VERSION = "0.1.0" as const;

export const PairMeshLocalConfigVersionSchema = z.literal(PAIRMESH_LOCAL_CONFIG_VERSION);

export const PairMeshLocalAgentConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  port: z.union([z.number().int().min(1024).max(65535), z.literal("auto")]),
  bindHost: z.string().trim().min(1).optional(),
  advertise: z.string().trim().min(1).optional()
});

export const PairMeshLocalCodingAgentConfigSchema = z.strictObject({
  provider: z.enum(["cursor", "gemini-cli", "claude-code", "fake"]).default("cursor"),
  mode: z.enum(["ask", "plan", "agent"]).default("ask")
});

export const PairMeshLocalConnectivityConfigSchema = z.strictObject({
  mode: z.enum(["direct-url", "overlay", "relay"]).default("direct-url"),
  /** Optional override; when omitted, the built-in hosted relay is used. */
  relayUrl: z.string().trim().url().optional()
});

export const PairMeshTestProfileSchema = z.strictObject({
  executable: z.string().trim().min(1).max(200),
  args: z.array(z.string().min(0).max(500)).max(50).default([]),
  /** Workspace-relative directory; never absolute / never escapes root. */
  cwd: z.string().trim().min(1).max(500).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  /** Receiver-owned safe env overrides only (no requester env). */
  env: z.record(z.string().trim().min(1).max(100), z.string().max(2_000)).optional(),
  maxOutputBytes: z.number().int().min(1_024).max(2_000_000).default(65_536)
});
export type PairMeshTestProfile = z.infer<typeof PairMeshTestProfileSchema>;

export const PairMeshTestsConfigSchema = z.strictObject({
  /** Max concurrent tests.run processes per workspace (V1 default 1). */
  maxConcurrent: z.number().int().min(1).max(4).default(1),
  /**
   * Profiles that may run without per-request approval when the peer has
   * capability policy `allow_session`. Other profiles still require allow-once.
   */
  sessionAllowedProfiles: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  profiles: z.record(z.string().trim().min(1).max(80), PairMeshTestProfileSchema).default({})
});
export type PairMeshTestsConfig = z.infer<typeof PairMeshTestsConfigSchema>;

export const PairMeshProcessExecutionConfigSchema = z.strictObject({
  maxConcurrent: z.number().int().min(1).max(2).default(1),
  defaultTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  maxTimeoutMs: z.number().int().min(1_000).max(600_000).default(600_000),
  maxOutputBytes: z.number().int().min(1_024).max(2_000_000).default(262_144),
  /** Receiver-owned safe env overrides only (no requester env). */
  env: z.record(z.string().trim().min(1).max(100), z.string().max(2_000)).default({})
});
export type PairMeshProcessExecutionConfig = z.infer<typeof PairMeshProcessExecutionConfigSchema>;

export const PairMeshLocalConfigSchema = z.strictObject({
  configVersion: PairMeshLocalConfigVersionSchema,
  projectId: ProjectIdSchema,
  agent: PairMeshLocalAgentConfigSchema,
  workspace: z.string().trim().min(1),
  codingAgent: PairMeshLocalCodingAgentConfigSchema,
  connectivity: PairMeshLocalConnectivityConfigSchema.default({ mode: "direct-url" }),
  tests: PairMeshTestsConfigSchema.default({
    maxConcurrent: 1,
    sessionAllowedProfiles: [],
    profiles: {}
  }),
  processExecution: PairMeshProcessExecutionConfigSchema.default({
    maxConcurrent: 1,
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 600_000,
    maxOutputBytes: 262_144,
    env: {}
  })
});

export type PairMeshLocalConfig = z.infer<typeof PairMeshLocalConfigSchema>;

export const PairMeshRuntimeInfoSchema = z.strictObject({
  pid: z.number().int().positive(),
  port: z.number().int().min(1024).max(65535),
  baseUrl: z.string().trim().min(1),
  bindHost: z.string().trim().min(1).optional(),
  advertisedUrl: z.string().trim().min(1).optional(),
  agentName: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
  startedAt: z.string().trim().min(1),
  mode: z.enum(["background", "foreground"]).optional(),
  logFile: z.string().trim().min(1).optional(),
  /** Loopback Control API base URL (never advertised on Agent Card / A2A). */
  controlUrl: z.string().trim().min(1).optional(),
  /** Runtime control token — host-process only; never print by default. */
  controlToken: z.string().trim().min(1).optional()
});

export type PairMeshRuntimeInfo = z.infer<typeof PairMeshRuntimeInfoSchema>;
