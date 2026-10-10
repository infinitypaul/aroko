import { createLocalPairMeshIdentity } from "@pairmesh/client";
import {
  LocalStateStore,
  createSessionSecurity,
  generateBearerToken,
  registerInboundCredential,
  type LocalParticipantRecord
} from "@pairmesh/client";
import { PeerIdSchema } from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";

export async function addConfiguredPeer(
  stateStore: LocalStateStore,
  options: { name: string; a2aAgentUrl: string }
): Promise<LocalParticipantRecord> {
  const loaded = await stateStore.load();
  if (!loaded) {
    throw new Error("expected active session state");
  }

  const identity = createLocalPairMeshIdentity(options.name, options.a2aAgentUrl);
  const peerRecord: LocalParticipantRecord = {
    participant: {
      id: PeerIdSchema.parse(`peer_${randomUUID()}`),
      sessionId: loaded.session.id,
      developerId: identity.developer.id,
      agentId: identity.agent.id,
      joinedAt: new Date().toISOString()
    },
    agent: identity.agent,
    developer: identity.developer,
    device: identity.device,
    a2aAgentUrl: options.a2aAgentUrl,
    isLocal: false,
    outboundBearer: generateBearerToken()
  };

  loaded.peers.push(peerRecord);

  // Mirror a completed pairing so authenticated calls in both directions work.
  const security = loaded.sessionSecurity ?? createSessionSecurity();
  loaded.sessionSecurity = {
    ...security,
    acceptedInbound: [
      ...security.acceptedInbound,
      registerInboundCredential(peerRecord.participant.id, generateBearerToken())
    ]
  };

  await stateStore.save(loaded);
  return peerRecord;
}
