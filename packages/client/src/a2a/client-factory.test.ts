import { describe, expect, it } from "vitest";
import { rewriteAgentCardTransportUrls } from "./client-factory.js";

describe("rewriteAgentCardTransportUrls", () => {
  it("rewrites localhost peer A2A URLs onto the relay egress origin", () => {
    const card = {
      name: "paul-agent",
      description: "test",
      supportedInterfaces: [
        {
          url: "http://127.0.0.1:47201/a2a",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          tenant: ""
        }
      ]
    };

    const rewritten = rewriteAgentCardTransportUrls(card as never, "http://127.0.0.1:60931");
    expect(rewritten.supportedInterfaces?.[0]?.url).toBe("http://127.0.0.1:60931/a2a");
    expect(rewritten.supportedInterfaces?.[0]?.protocolBinding).toBe("JSONRPC");
  });
});
