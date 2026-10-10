import { describe, expect, it } from "vitest";
import { processPairMeshInspectionRequest } from "./handler.js";
import { FakeCodingAgentAdapter } from "../coding-agent/fake-adapter.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InspectionThreadIdSchema,
  PAIRMESH_METADATA_VERSION,
  SessionIdSchema
} from "@pairmesh/protocol";

const fixtureWorkspace = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/payment-workspace"
);

const sessionId = SessionIdSchema.parse("ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");
const threadId = InspectionThreadIdSchema.parse("thr_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed");

describe("processPairMeshInspectionRequest", () => {
  it("returns structured inspection success through adapter boundary", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const response = await processPairMeshInspectionRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        threadId,
        requestId: "req_test",
        question: "What fields does the successful payment response contain?",
        turnNumber: 1
      },
      adapter
    );

    expect(response.accepted).toBe(true);
    if (response.accepted) {
      expect(response.summary.toLowerCase()).toMatch(/customerid|paymentreference/);
      expect(response.findings.length).toBeGreaterThan(0);
      expect(response.references).toEqual([
        {
          file: "src/payment.ts",
          symbol: "buildSuccessfulPaymentResponse",
          startLine: 1,
          endLine: 6,
          kind: "function"
        }
      ]);
    }
  });

  it("maps adapter failures to PairMesh inspection failures", async () => {
    const adapter = {
      inspect: async () => {
        throw {
          code: "agent_unavailable",
          message: "Cursor CLI is not installed or not available in PATH."
        };
      },
      getAvailability: async () => ({
        provider: "fake" as const,
        configured: false,
        status: "unavailable" as const
      })
    };

    const response = await processPairMeshInspectionRequest(
      {
        metadataVersion: PAIRMESH_METADATA_VERSION,
        sessionId,
        threadId,
        requestId: "req_fail",
        question: "test",
        turnNumber: 1
      },
      adapter
    );

    expect(response.accepted).toBe(false);
    if (!response.accepted) {
      expect(response.error.code).toBe("pairmesh.coding_agent_unavailable");
    }
  });
});
