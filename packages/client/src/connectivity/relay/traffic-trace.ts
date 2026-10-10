import type { RelayWireFrame } from "./frames.js";

const MAX_WIRE_SAMPLES = 24;

export interface RelayTrafficWireSample {
  type: string;
  toParticipantId?: string;
  fromParticipantId?: string;
  channelId?: string;
  hasCiphertext: boolean;
  wireBytes: number;
}

export interface RelayTrafficSnapshot {
  capturedAt: string;
  forwardedFramesReceived: number;
  forwardedFramesSent: number;
  receivedByFromParticipantId: Record<string, number>;
  receivedByChannelId: Record<string, number>;
  sentByToParticipantId: Record<string, number>;
  wireSamples: RelayTrafficWireSample[];
  /** True if any recorded wire JSON contained a registered canary substring. */
  wireLeakedCanary: boolean;
  wireCanaryHits: string[];
}

/**
 * Process-local forward-frame counters for live unicast validation.
 * Records routing metadata only — never stores ciphertext or plaintext payloads.
 */
export class RelayTrafficTracer {
  private forwardedFramesReceived = 0;
  private forwardedFramesSent = 0;
  private readonly receivedByFromParticipantId = new Map<string, number>();
  private readonly receivedByChannelId = new Map<string, number>();
  private readonly sentByToParticipantId = new Map<string, number>();
  private readonly wireSamples: RelayTrafficWireSample[] = [];
  private readonly canaryHits = new Set<string>();
  private readonly canaries = new Set<string>();

  registerCanary(value: string): void {
    const trimmed = value.trim();
    if (trimmed) {
      this.canaries.add(trimmed);
    }
  }

  reset(): void {
    this.forwardedFramesReceived = 0;
    this.forwardedFramesSent = 0;
    this.receivedByFromParticipantId.clear();
    this.receivedByChannelId.clear();
    this.sentByToParticipantId.clear();
    this.wireSamples.length = 0;
    this.canaryHits.clear();
  }

  recordReceivedForward(frame: RelayWireFrame, wireJson: string): void {
    if (frame.type !== "forward") {
      return;
    }
    this.forwardedFramesReceived += 1;
    if (frame.fromParticipantId) {
      this.bump(this.receivedByFromParticipantId, frame.fromParticipantId);
    }
    if (frame.channelId) {
      this.bump(this.receivedByChannelId, frame.channelId);
    }
    this.recordWireSample(frame, wireJson);
  }

  recordSentForward(frame: RelayWireFrame, wireJson: string): void {
    if (frame.type !== "forward") {
      return;
    }
    this.forwardedFramesSent += 1;
    if (frame.toParticipantId) {
      this.bump(this.sentByToParticipantId, frame.toParticipantId);
    }
    this.recordWireSample(frame, wireJson);
  }

  snapshot(): RelayTrafficSnapshot {
    return {
      capturedAt: new Date().toISOString(),
      forwardedFramesReceived: this.forwardedFramesReceived,
      forwardedFramesSent: this.forwardedFramesSent,
      receivedByFromParticipantId: Object.fromEntries(this.receivedByFromParticipantId),
      receivedByChannelId: Object.fromEntries(this.receivedByChannelId),
      sentByToParticipantId: Object.fromEntries(this.sentByToParticipantId),
      wireSamples: [...this.wireSamples],
      wireLeakedCanary: this.canaryHits.size > 0,
      wireCanaryHits: [...this.canaryHits]
    };
  }

  private bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private recordWireSample(frame: RelayWireFrame, wireJson: string): void {
    for (const canary of this.canaries) {
      if (wireJson.includes(canary)) {
        this.canaryHits.add(canary);
      }
    }
    if (this.wireSamples.length < MAX_WIRE_SAMPLES) {
      this.wireSamples.push({
        type: frame.type,
        ...(frame.toParticipantId ? { toParticipantId: frame.toParticipantId } : {}),
        ...(frame.fromParticipantId ? { fromParticipantId: frame.fromParticipantId } : {}),
        ...(frame.channelId ? { channelId: frame.channelId } : {}),
        hasCiphertext: Boolean(frame.ciphertextB64),
        wireBytes: wireJson.length
      });
    }
  }
}
