import { describe, expect, it } from "vitest";
import { renderBanner } from "./index.js";

describe("CLI bootstrap", () => {
  it("renders the initial banner", () => {
    const output = renderBanner();
    expect(output).toContain("Aroko");
    expect(output).toContain("Pair programming, agent to agent.");
  });
});
