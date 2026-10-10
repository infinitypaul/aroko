import { describe, expect, it } from "vitest";
import { getBootstrapStatus } from "./index.js";

describe("coordination bootstrap", () => {
  it("returns a healthy bootstrap status", () => {
    const status = getBootstrapStatus();
    expect(status.service).toBe("coordination");
    expect(status.healthy).toBe(true);
    expect(typeof status.startedAtIso).toBe("string");
  });
});
