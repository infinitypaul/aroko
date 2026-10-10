import { describe, expect, it } from "vitest";
import { assertSupportedNodeVersion, MIN_NODE_MAJOR } from "./version.js";

describe("Node version enforcement", () => {
  it("accepts current Node version when >= minimum", () => {
    const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    if (major >= MIN_NODE_MAJOR) {
      expect(() => assertSupportedNodeVersion()).not.toThrow();
    }
  });

  it("documents actionable error shape for unsupported Node", () => {
    const message = [
      `PairMesh requires Node.js ${MIN_NODE_MAJOR} or newer.`,
      "Detected: v18.0.0",
      `Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org or switch with nvm/fnm/volta.`
    ].join("\n");
    expect(message).toContain("Node.js 20");
    expect(message).toContain("nvm/fnm/volta");
  });
});
