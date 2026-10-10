import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { RelayChannelIdSchema, type RelayChannelId } from "./frames.js";

export function deriveRelayChannelId(input: {
  relaySessionId: string;
  localParticipantId: string;
  remoteParticipantId: string;
}): RelayChannelId {
  const [a, b] = [input.localParticipantId, input.remoteParticipantId].sort();
  const digest = sha256(
    new TextEncoder().encode(`pairmesh-relay-channel-v1|${input.relaySessionId}|${a}|${b}`)
  );
  return RelayChannelIdSchema.parse(`rch_${bytesToHex(digest.subarray(0, 16))}`);
}
