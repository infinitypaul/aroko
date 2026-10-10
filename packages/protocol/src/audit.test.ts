import { describe, expect, it } from "vitest";
import { PAIRMESH_AUDIT_VERSION, PairMeshAuditEventSchema, AuditEventIdSchema } from "./index.js";

describe("PairMesh audit event schema", () => {
  it("accepts an allow-listed inspection.result_shared event", () => {
    const parsed = PairMeshAuditEventSchema.parse({
      version: PAIRMESH_AUDIT_VERSION,
      eventId: AuditEventIdSchema.parse("aud_11111111-1111-4111-8111-111111111111"),
      timestamp: "2026-08-20T15:00:00.000Z",
      eventType: "inspection.result_shared",
      metadata: {
        direction: "outbound",
        summaryPresent: true,
        findingCount: 2,
        referenceCount: 1,
        referencedFiles: ["src/retry.ts"]
      }
    });
    expect(parsed.metadata.referencedFiles).toEqual(["src/retry.ts"]);
  });

  it("rejects absolute paths in referencedFiles", () => {
    expect(() =>
      PairMeshAuditEventSchema.parse({
        version: PAIRMESH_AUDIT_VERSION,
        eventId: "aud_11111111-1111-4111-8111-111111111111",
        timestamp: "2026-08-20T15:00:00.000Z",
        eventType: "inspection.result_shared",
        metadata: {
          direction: "outbound",
          summaryPresent: false,
          findingCount: 0,
          referenceCount: 1,
          referencedFiles: ["/Users/kelvin/Sites/secret/src/retry.ts"]
        }
      })
    ).toThrow();
  });

  it("rejects unknown metadata keys", () => {
    expect(() =>
      PairMeshAuditEventSchema.parse({
        version: PAIRMESH_AUDIT_VERSION,
        eventId: "aud_11111111-1111-4111-8111-111111111111",
        timestamp: "2026-08-20T15:00:00.000Z",
        eventType: "session.created",
        metadata: { question: "PAIR_MESH_PRIVATE_QUESTION_DO_NOT_LOG" }
      })
    ).toThrow();
  });
});
