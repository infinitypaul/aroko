import {
  PairMeshRuntimeHealthSchema,
  type PairMeshRuntimeHealth,
  type PairMeshRuntimeHealthStatus
} from "@pairmesh/protocol";
import type { CodingAgentAdapter, CodingAgentAvailability } from "../coding-agent/types.js";
import type { LocalStateStore } from "../state/store.js";

export interface LocalRuntimeHealthOptions {
    includeOperationalDetail?: boolean;
}

export async function buildLocalRuntimeHealth(
  agentName: string,
  codingAgentAdapter: CodingAgentAdapter,
  stateStore?: LocalStateStore,
  projectId?: string,
  options: LocalRuntimeHealthOptions = {}
): Promise<PairMeshRuntimeHealth> {
  const includeDetail = options.includeOperationalDetail ?? true;
  const timestamp = new Date().toISOString();
  let sessionActive = false;

  if (stateStore) {
    try {
      const state = await stateStore.load();
      sessionActive = state?.session.status === "active";
    } catch {
      sessionActive = false;
    }
  }

  let codingAgent: CodingAgentAvailability;
  try {
    codingAgent = await codingAgentAdapter.getAvailability();
  } catch {
    codingAgent = {
      provider: "cursor",
      configured: false,
      status: "unavailable",
      reason: "Coding agent availability check failed."
    };
  }

  const readyForInspection =
    sessionActive &&
    codingAgent.configured &&
    (codingAgent.status === "available" || codingAgent.status === "busy");

  const status = resolveRuntimeStatus(sessionActive, codingAgent, readyForInspection);

  if (!includeDetail) {
    return PairMeshRuntimeHealthSchema.parse({
      status,
      agent: { name: agentName },
      timestamp,
      readyForInspection
    });
  }

  return PairMeshRuntimeHealthSchema.parse({
    status,
    agent: { name: agentName },
    ...(projectId ? { project: { projectId } } : {}),
    codingAgent: {
      provider: codingAgent.provider,
      configured: codingAgent.configured,
      status: codingAgent.status,
      ...(codingAgent.reason ? { reason: codingAgent.reason } : {})
    },
    timestamp,
    readyForInspection
  });
}

function resolveRuntimeStatus(
  sessionActive: boolean,
  codingAgent: CodingAgentAvailability,
  readyForInspection: boolean
): PairMeshRuntimeHealthStatus {
  if (!sessionActive) {
    return codingAgent.configured ? "degraded" : "unavailable";
  }
  if (readyForInspection) {
    return codingAgent.status === "busy" ? "degraded" : "ready";
  }
  if (codingAgent.configured && codingAgent.status === "unavailable") {
    return "degraded";
  }
  return "unavailable";
}
