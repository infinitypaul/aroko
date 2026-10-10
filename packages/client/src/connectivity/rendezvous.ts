import type { RelayAccessToken, RelaySessionId } from "./relay/frames.js";

export interface LocalRelayRendezvousRecord {
  sessionCode: string;
  relayUrl: string;
  relaySessionId: RelaySessionId;
  relayAccessToken: RelayAccessToken;
  /** Creator advertised direct URL still available for overlay mode. */
  creatorDirectUrl?: string;
}

export class LocalRelayRendezvous {
  private readonly byCode = new Map<string, LocalRelayRendezvousRecord>();

  register(record: LocalRelayRendezvousRecord): void {
    this.byCode.set(record.sessionCode, record);
  }

  lookup(sessionCode: string): LocalRelayRendezvousRecord | undefined {
    return this.byCode.get(sessionCode);
  }

  clear(): void {
    this.byCode.clear();
  }
}
