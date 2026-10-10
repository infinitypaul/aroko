export type ConnectivityMode = "direct-url" | "overlay" | "relay";

export interface PeerConnectivityHint {
  mode: ConnectivityMode;
  /** Direct/overlay A2A base URL when mode is not relay. */
  a2aAgentUrl?: string;
  relayUrl?: string;
  relaySessionId?: string;
  relayAccessToken?: string;
  peerTransportPublicKey?: string;
}

export interface ResolvedDirectTransport {
  mode: "direct-url" | "overlay";
  transportEndpoint: string;
}

export interface ResolvedRelayTransport {
  mode: "relay";
  /** Local loopback HTTP endpoint that tunnels over encrypted relay. */
  transportEndpoint: string;
  relayUrl: string;
  relaySessionId: string;
}

export type PairMeshResolvedTransport = ResolvedDirectTransport | ResolvedRelayTransport;

/**
 * Provider-neutral connectivity resolver. Relay specifics stay behind this boundary;
 * SessionManager/A2A should consume `transportEndpoint` only.
 */
export interface PairMeshConnectivityResolver {
  resolvePeer(peer: PeerConnectivityHint): Promise<PairMeshResolvedTransport>;
}

export class DefaultConnectivityResolver implements PairMeshConnectivityResolver {
  async resolvePeer(peer: PeerConnectivityHint): Promise<PairMeshResolvedTransport> {
    if (peer.mode === "relay") {
      if (!peer.relayUrl || !peer.relaySessionId) {
        throw new Error("Relay mode requires relayUrl and relaySessionId");
      }
      // transportEndpoint is filled by the caller after opening RelayHttpEgress.
      return {
        mode: "relay",
        transportEndpoint: "",
        relayUrl: peer.relayUrl,
        relaySessionId: peer.relaySessionId
      };
    }
    if (!peer.a2aAgentUrl) {
      throw new Error("Direct/overlay mode requires a2aAgentUrl");
    }
    return {
      mode: peer.mode,
      transportEndpoint: peer.a2aAgentUrl
    };
  }
}
