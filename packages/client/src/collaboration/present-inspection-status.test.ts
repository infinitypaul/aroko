import { describe, expect, it } from "vitest";
import { presentInspectionHuman } from "./present.js";
import type { PeerInspectionResult } from "../session/manager.js";

describe("presentInspectionHuman status TypeError guards", () => {
  it("completed result with missing findings does not throw", () => {
    const result = {
      completed: true,
      threadId: "thr_1",
      peer: "sarah",
      requestId: "req_1",
      question: "hi",
      summary: "ok",
      findings: undefined,
      references: []
    } as unknown as PeerInspectionResult;
    expect(() => presentInspectionHuman(result)).not.toThrow();
    expect(presentInspectionHuman(result)).toContain("Completed");
  });

  it("working result without status falls back safely", () => {
    const result = {
      completed: false,
      threadId: "thr_1",
      peer: "sarah",
      requestId: "req_1",
      question: "hi",
      message: "still going"
    } as unknown as PeerInspectionResult;
    expect(presentInspectionHuman(result)).toContain("still going");
  });
});
