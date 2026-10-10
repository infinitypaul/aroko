import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { createPairMeshError } from "@pairmesh/protocol";
import type { DirectionalTransportKeys } from "./keys.js";

const MAX_SKIP = 64;

export interface EncryptedTransportFrame {
  version: 1;
  sequence: number;
  ciphertext: Uint8Array;
}

export class E2ETransportSession {
  private sendSequence = 0n;
  private receiveSequence = 0n;
  private readonly seenReceive = new Set<string>();

  constructor(private readonly keys: DirectionalTransportKeys) {}

  encrypt(plaintext: Uint8Array): EncryptedTransportFrame {
    const sequence = this.sendSequence;
    this.sendSequence += 1n;
    if (this.sendSequence > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw createPairMeshError({
        code: "pairmesh.internal_error",
        message: "Transport send sequence exhausted; rekey required."
      });
    }
    const nonce = sequenceToNonce(sequence);
    const ciphertext = chacha20poly1305(this.keys.sendKey, nonce).encrypt(plaintext);
    return {
      version: 1,
      sequence: Number(sequence),
      ciphertext
    };
  }

  decrypt(frame: EncryptedTransportFrame): Uint8Array {
    if (frame.version !== 1) {
      throw createPairMeshError({
        code: "pairmesh.transport_decryption_failed",
        message: "Unsupported transport envelope version."
      });
    }
    const seq = BigInt(frame.sequence);
    const key = seq.toString();
    if (this.seenReceive.has(key)) {
      throw createPairMeshError({
        code: "pairmesh.transport_replay_rejected",
        message: "Duplicate transport frame rejected."
      });
    }
    if (seq < this.receiveSequence) {
      throw createPairMeshError({
        code: "pairmesh.transport_replay_rejected",
        message: "Out-of-order transport frame rejected."
      });
    }
    if (seq > this.receiveSequence + BigInt(MAX_SKIP)) {
      throw createPairMeshError({
        code: "pairmesh.transport_replay_rejected",
        message: "Transport frame outside receive window."
      });
    }

    try {
      const plaintext = chacha20poly1305(this.keys.receiveKey, sequenceToNonce(seq)).decrypt(
        frame.ciphertext
      );
      this.seenReceive.add(key);
      // Advance contiguous watermark; tolerate limited gaps already tracked in seen set.
      while (this.seenReceive.has(this.receiveSequence.toString())) {
        this.receiveSequence += 1n;
      }
      return plaintext;
    } catch {
      throw createPairMeshError({
        code: "pairmesh.transport_decryption_failed",
        message: "Transport decryption failed."
      });
    }
  }

  /** Test/helper: next send sequence without encrypting. */
  peekSendSequence(): number {
    return Number(this.sendSequence);
  }
}

function sequenceToNonce(sequence: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, 0, false);
  view.setBigUint64(4, sequence, false);
  return nonce;
}
