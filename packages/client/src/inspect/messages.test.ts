import { describe, expect, it } from "vitest";
import {
  assertSafeInspectionUserText,
  formatInspectionCompletedText,
  formatInspectionStillWorkingMessage,
  formatInspectionWaitExpiredMessage,
  formatInspectionWorkingMessage
} from "./messages.js";

describe("inspection user-facing messages", () => {
  it("describes working state with requestId and without timeout/CLI language", () => {
    const text = formatInspectionWorkingMessage("kelvin-agent", "req_test");
    expect(text.toLowerCase()).toContain("still working");
    expect(text).toContain("req_test");
    expect(text).toContain("pairmesh_wait_for_inspection");
    expect(text.toLowerCase()).not.toContain("timed out");
    expect(text.toLowerCase()).not.toContain("failed");
    expect(text.toLowerCase()).not.toContain("pairmesh init");
    expect(text.toLowerCase()).not.toContain("quick start");
  });

  it("describes wait-still-working without timeout language", () => {
    const text = formatInspectionStillWorkingMessage("kelvin-agent", "req_test");
    expect(text.toLowerCase()).toContain("still working");
    expect(text).toContain("req_test");
    expect(text.toLowerCase()).not.toContain("timed out");
    expect(text.toLowerCase()).not.toContain("failed");
  });

  it("describes local wait expiry as distinct from remote failure", () => {
    const text = formatInspectionWaitExpiredMessage("kelvin-agent", "req_test");
    expect(text.toLowerCase()).toContain("still working");
    expect(text.toLowerCase()).toContain("resume");
    expect(text.toLowerCase()).toContain("do not start a new ask");
    expect(text).toContain("req_test");
    expect(text).toContain("req_test");
  });

  it("presents completion as the peer's answer", () => {
    const text = formatInspectionCompletedText({
      peerName: "kelvin-agent",
      summary: "rebuildPaymentFromRetryRecord handles rebuilds.",
      findings: ["Defined in src/retry.ts"]
    });
    expect(text.startsWith("kelvin-agent found:")).toBe(true);
    expect(text).toContain("rebuildPaymentFromRetryRecord");
    expect(text).not.toMatch(/request req_/i);
    expect(text.toLowerCase()).not.toContain("status is completed");
  });

  it("rejects unsafe user text patterns", () => {
    expect(() => assertSafeInspectionUserText("ok")).not.toThrow();
    expect(() => assertSafeInspectionUserText("/Users/secret/project")).toThrow(/Unsafe/);
  });
});
