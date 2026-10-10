import { PROTOCOL_INVARIANTS } from "@pairmesh/protocol";

export class PairMeshClientBootstrap {
  public readonly name = "PairMeshClientBootstrap";

  validateProtocolBoundary(): boolean {
    return (
      PROTOCOL_INVARIANTS.a2aIsNativeInterAgentProtocol && PROTOCOL_INVARIANTS.mcpIsClientBoundary
    );
  }
}
