import { describe, expect, it } from "vitest";
import { InspectionThreadIdSchema, InspectionTurnIdSchema } from "./ids.js";
import {
  PairMeshInspectionThreadSchema,
  PairMeshInspectionTurnSchema
} from "./inspection-thread.js";
import { PairMeshInspectionRequestSchema } from "./inspection.js";

describe("inspection thread schemas", () => {
  it("accepts thr_ and trn_ prefixed ids", () => {
    expect(InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed")).toBeTruthy();
    expect(InspectionTurnIdSchema.parse("trn_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed")).toBeTruthy();
  });

  it("validates inspection thread metadata", () => {
    const parsed = PairMeshInspectionThreadSchema.parse({
      id: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      sessionId: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      initiatorPeerId: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      targetPeerId: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afee",
      status: "active",
      createdAt: "2026-08-19T19:00:00.000Z",
      updatedAt: "2026-08-19T19:00:00.000Z"
    });
    expect(parsed.status).toBe("active");
  });

  it("requires threadId on inspection requests", () => {
    const parsed = PairMeshInspectionRequestSchema.parse({
      metadataVersion: "0.1.0",
      sessionId: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      requestId: "req_test",
      question: "Why?",
      turnNumber: 2
    });
    expect(parsed.turnNumber).toBe(2);
  });

  it("validates inspection turn metadata", () => {
    const parsed = PairMeshInspectionTurnSchema.parse({
      id: "trn_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      threadId: "thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      requestId: "req_test",
      question: "Why?",
      createdAt: "2026-08-19T19:00:00.000Z"
    });
    expect(parsed.threadId).toContain("thr_");
  });
});
