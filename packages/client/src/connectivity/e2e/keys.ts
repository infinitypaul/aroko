import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const INFO_PREFIX = "pairmesh-e2e-v1";

export interface TransportKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface DirectionalTransportKeys {
  /** Encrypt frames Paul→Kelvin (or local→peer). */
  sendKey: Uint8Array;
  /** Decrypt frames peer→local. */
  receiveKey: Uint8Array;
}

export function generateTransportKeyPair(): TransportKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { privateKey: secretKey, publicKey };
}

export function encodePublicKey(publicKey: Uint8Array): string {
  return bytesToHex(publicKey);
}

export function decodePublicKey(hex: string): Uint8Array {
  const bytes = hexToBytes(hex.trim());
  if (bytes.length !== 32) {
    throw new Error("transport public key must be 32 bytes");
  }
  return bytes;
}

export function deriveDirectionalKeys(input: {
  localPrivateKey: Uint8Array;
  peerPublicKey: Uint8Array;
  sessionId: string;
  localParticipantId: string;
  peerParticipantId: string;
  /** Opaque pairwise channel id (`rch_…`); binds keys per logical channel. */
  channelId?: string;
}): DirectionalTransportKeys {
  const shared = x25519.getSharedSecret(input.localPrivateKey, input.peerPublicKey);
  const salt = sha256(new TextEncoder().encode(`${INFO_PREFIX}|${input.sessionId}`));
  const channelSuffix = input.channelId ? `|channel|${input.channelId}` : "";
  const sendInfo = new TextEncoder().encode(
    `${INFO_PREFIX}|send|${input.localParticipantId}->${input.peerParticipantId}${channelSuffix}`
  );
  const recvInfo = new TextEncoder().encode(
    `${INFO_PREFIX}|send|${input.peerParticipantId}->${input.localParticipantId}${channelSuffix}`
  );
  return {
    sendKey: hkdf(sha256, shared, salt, sendInfo, 32),
    receiveKey: hkdf(sha256, shared, salt, recvInfo, 32)
  };
}
