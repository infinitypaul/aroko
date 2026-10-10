import { PairMeshErrorSchema } from "@pairmesh/protocol";
import { discoverA2AAgentCard } from "../a2a/adapter.js";
import { assertPairMeshSessionSkill } from "../a2a/pairing-client.js";
import { normalizeAgentBaseUrl } from "../identity.js";
import { fetchLocalHealth } from "../health/peer-health.js";

export async function preflightJoinPeer(peerUrl: string): Promise<void> {
  let baseUrl: string;
  try {
    baseUrl = normalizeAgentBaseUrl(peerUrl);
  } catch {
    throw new Error("Creator peer URL is invalid. Expected an http:// address.");
  }

  try {
    new URL(baseUrl);
  } catch {
    throw new Error("Creator peer URL is invalid. Expected an http:// address.");
  }

  const health = await fetchLocalHealth(baseUrl);
  if (!health) {
    throw new Error(
      "Cannot reach PairMesh peer at the supplied address.\n\nCheck that your teammate's PairMesh runtime is running and that the address is reachable from this machine."
    );
  }

  let agentCard;
  try {
    agentCard = await discoverA2AAgentCard(baseUrl);
  } catch {
    throw new Error(
      "Cannot reach PairMesh peer at the supplied address.\n\nCheck that your teammate's PairMesh runtime is running and that the address is reachable from this machine."
    );
  }

  try {
    assertPairMeshSessionSkill(agentCard);
  } catch (error) {
    const parsed = PairMeshErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "pairmesh.capability_not_allowed") {
      throw new Error(
        "The target agent is reachable but does not support PairMesh session pairing (pairmesh.session skill missing)."
      );
    }
    throw error;
  }
}
