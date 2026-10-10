import { createPairMeshError } from "@pairmesh/protocol";
import { decodePublicKey, deriveDirectionalKeys, type TransportKeyPair } from "../e2e/keys.js";
import { E2ETransportSession } from "../e2e/session.js";
import { RELAY_MAX_LOGICAL_CHANNELS } from "./access-token.js";
import { deriveRelayChannelId } from "./channel-id.js";
import type { PairMeshRelayClient } from "./client.js";
import type { RelayChannelId, RelaySessionId } from "./frames.js";

export type RelayChannelStatus = "open" | "closed";

export interface RelayChannelRecord {
  channelId: RelayChannelId;
  remoteParticipantId: string;
  localParticipantId: string;
  status: RelayChannelStatus;
  e2e: E2ETransportSession;
}

export interface OpenRelayChannelInput {
  remoteParticipantId: string;
  /** Peer X25519 public key (hex or raw bytes). */
  remotePublicKey: string | Uint8Array;
  localParticipantId: string;
  localPrivateKey: Uint8Array;
  /** PairMesh session id for HKDF salt (falls back to manager default). */
  sessionId?: string;
  /** Relay session id for channel id derivation (falls back to manager default). */
  relaySessionId?: RelaySessionId | string;
}

/**
 * Manage pairwise logical channels on one attached {@link PairMeshRelayClient}.
 * One WebSocket; N independent E2E sessions keyed by `rch_…`.
 */
export class RelayChannelManager {
  private readonly channels = new Map<RelayChannelId, RelayChannelRecord>();
  private readonly byRemote = new Map<string, RelayChannelId>();

  constructor(
    private readonly client: PairMeshRelayClient,
    private readonly defaults: {
      relaySessionId: RelaySessionId | string;
      /** PairMesh collaboration / session id used in HKDF salt. */
      sessionId: string;
      localKeyPair?: TransportKeyPair;
    }
  ) {}

  openChannel(input: OpenRelayChannelInput): RelayChannelRecord {
    if (this.channels.size >= RELAY_MAX_LOGICAL_CHANNELS) {
      throw createPairMeshError({
        code: "pairmesh.relay_unavailable",
        message: `Logical channel limit (${RELAY_MAX_LOGICAL_CHANNELS}) reached.`
      });
    }
    const relaySessionId = input.relaySessionId ?? this.defaults.relaySessionId;
    const sessionId = input.sessionId ?? this.defaults.sessionId;
    const channelId = deriveRelayChannelId({
      relaySessionId: String(relaySessionId),
      localParticipantId: input.localParticipantId,
      remoteParticipantId: input.remoteParticipantId
    });
    const existing = this.channels.get(channelId);
    if (existing && existing.status === "open") {
      return existing;
    }

    const peerPublicKey =
      typeof input.remotePublicKey === "string"
        ? decodePublicKey(input.remotePublicKey)
        : input.remotePublicKey;
    const keys = deriveDirectionalKeys({
      localPrivateKey: input.localPrivateKey,
      peerPublicKey,
      sessionId,
      localParticipantId: input.localParticipantId,
      peerParticipantId: input.remoteParticipantId,
      channelId
    });
    const e2e = new E2ETransportSession(keys);
    this.client.setE2E(e2e, channelId);
    const record: RelayChannelRecord = {
      channelId,
      remoteParticipantId: input.remoteParticipantId,
      localParticipantId: input.localParticipantId,
      status: "open",
      e2e
    };
    this.channels.set(channelId, record);
    this.byRemote.set(input.remoteParticipantId, channelId);
    return record;
  }

  getChannel(channelIdOrRemote: string): RelayChannelRecord | undefined {
    const byId = this.channels.get(channelIdOrRemote as RelayChannelId);
    if (byId) return byId;
    const mapped = this.byRemote.get(channelIdOrRemote);
    return mapped ? this.channels.get(mapped) : undefined;
  }

  status(channelIdOrRemote: string): RelayChannelStatus | undefined {
    return this.getChannel(channelIdOrRemote)?.status;
  }

  closeChannel(channelIdOrRemote: string): void {
    const record = this.getChannel(channelIdOrRemote);
    if (!record) return;
    record.status = "closed";
    this.client.clearE2EChannel(record.channelId);
    this.channels.delete(record.channelId);
    this.byRemote.delete(record.remoteParticipantId);
  }

  listOpen(): RelayChannelRecord[] {
    return [...this.channels.values()].filter((c) => c.status === "open");
  }
}
