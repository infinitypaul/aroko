import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_OWNER_VISIBILITY,
  isRuntimeCapabilityEnabled,
  mayInstallReceiverSessionAwareness
} from "./provider-visibility.js";

describe("owner-visibility capability matrix (API truth)", () => {
  it("does not treat Claude as the only hooks+MCP-capable runtime", () => {
    expect(CODING_AGENT_OWNER_VISIBILITY["claude-code"].activeSessionDiscovery).toBe(true);
    expect(CODING_AGENT_OWNER_VISIBILITY["claude-code"].receiverMcpClient).toBe(true);
    expect(CODING_AGENT_OWNER_VISIBILITY["gemini-cli"].activeSessionDiscovery).toBe(true);
    expect(CODING_AGENT_OWNER_VISIBILITY["gemini-cli"].receiverMcpClient).toBe(true);
    expect(CODING_AGENT_OWNER_VISIBILITY["gemini-cli"].activeSessionInboundPush).toBe(
      "hooks_and_mcp"
    );
  });

  it("resolves Cursor needs_verification to evidence-backed API support", () => {
    expect(CODING_AGENT_OWNER_VISIBILITY.cursor.activeSessionDiscovery).toBe(true);
    expect(CODING_AGENT_OWNER_VISIBILITY.cursor.receiverMcpClient).toBe(true);
    expect(CODING_AGENT_OWNER_VISIBILITY.cursor.activeSessionInboundPush).toBe("hooks_and_mcp");
    expect(CODING_AGENT_OWNER_VISIBILITY.cursor.pairmeshReceiverSessionIntegration).toBe(
      "not_shipped"
    );
    expect(isRuntimeCapabilityEnabled(true)).toBe(true);
  });

  it("separates PairMesh ship status from runtime API capability", () => {
    expect(CODING_AGENT_OWNER_VISIBILITY["claude-code"].pairmeshReceiverSessionIntegration).toBe(
      "shipped"
    );
    expect(CODING_AGENT_OWNER_VISIBILITY["gemini-cli"].pairmeshReceiverSessionIntegration).toBe(
      "not_shipped"
    );
    expect(CODING_AGENT_OWNER_VISIBILITY.cursor.pairmeshReceiverSessionIntegration).toBe(
      "not_shipped"
    );
    expect(mayInstallReceiverSessionAwareness(CODING_AGENT_OWNER_VISIBILITY["claude-code"])).toBe(
      true
    );
    expect(mayInstallReceiverSessionAwareness(CODING_AGENT_OWNER_VISIBILITY["gemini-cli"])).toBe(
      false
    );
    expect(mayInstallReceiverSessionAwareness(CODING_AGENT_OWNER_VISIBILITY.cursor)).toBe(false);
  });
});
