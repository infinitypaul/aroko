import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  normalizeRepositoryRelativePath,
  parseInspectionAgentOutput,
  sanitizeSourceReferences,
  validateReferencesInWorkspace
} from "./source-references.js";
import { SOURCE_REFERENCES_BEGIN, SOURCE_REFERENCES_END } from "./prompt.js";
import { FakeCodingAgentAdapter } from "./fake-adapter.js";

const fixtureWorkspace = join(process.cwd(), "fixtures", "payment-workspace");
const workspacePrefix = "/Users/paul/Sites/project";

describe("normalizeRepositoryRelativePath", () => {
  it("strips configured workspace prefix from absolute paths", () => {
    expect(
      normalizeRepositoryRelativePath(`${workspacePrefix}/src/payment.ts`, workspacePrefix)
    ).toBe("src/payment.ts");
  });

  it("rejects paths outside workspace when absolute", () => {
    expect(
      normalizeRepositoryRelativePath("/Users/other/project/src/payment.ts", workspacePrefix)
    ).toBeUndefined();
  });
});

describe("parseInspectionAgentOutput", () => {
  it("parses prose and structured reference block", () => {
    const text = [
      "Summary line",
      "- finding one",
      SOURCE_REFERENCES_BEGIN,
      JSON.stringify([
        {
          file: "src/payment.ts",
          symbol: "buildSuccessfulPaymentResponse",
          startLine: 1,
          endLine: 6
        }
      ]),
      SOURCE_REFERENCES_END
    ].join("\n");

    const parsed = parseInspectionAgentOutput(text);
    expect(parsed.summary).toContain("Summary line");
    expect(parsed.findings).toEqual(["finding one"]);
    expect(parsed.references[0]?.file).toBe("src/payment.ts");
  });

  it("degrades gracefully when reference JSON is invalid", () => {
    const text = [
      "Useful answer",
      "- still useful",
      SOURCE_REFERENCES_BEGIN,
      "{not json",
      SOURCE_REFERENCES_END
    ].join("\n");

    const parsed = parseInspectionAgentOutput(text);
    expect(parsed.summary).toContain("Useful answer");
    expect(parsed.references).toEqual([]);
  });
});

describe("sanitizeSourceReferences", () => {
  it("drops unsafe references", () => {
    const sanitized = sanitizeSourceReferences(
      [{ file: "../secret.ts" }, { file: "src/payment.ts" }],
      fixtureWorkspace
    );
    expect(sanitized).toEqual([{ file: "src/payment.ts" }]);
  });
});

describe("validateReferencesInWorkspace", () => {
  it("drops references to missing files", async () => {
    const validated = await validateReferencesInWorkspace(
      [{ file: "src/missing.ts" }, { file: "src/payment.ts", startLine: 1, endLine: 6 }],
      fixtureWorkspace
    );
    expect(validated).toEqual([{ file: "src/payment.ts", startLine: 1, endLine: 6 }]);
  });

  it("strips invalid line ranges but keeps file reference", async () => {
    const validated = await validateReferencesInWorkspace(
      [
        {
          file: "src/payment.ts",
          startLine: 250,
          endLine: 260,
          symbol: "buildSuccessfulPaymentResponse"
        }
      ],
      fixtureWorkspace
    );
    expect(validated).toEqual([
      { file: "src/payment.ts", symbol: "buildSuccessfulPaymentResponse" }
    ]);
  });
});

describe("FakeCodingAgentAdapter references", () => {
  it("returns deterministic payment fixture references", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const result = await adapter.inspect({
      requestId: "req_refs",
      question: "What fields does the successful payment response contain?"
    });

    expect(result.references).toEqual([
      {
        file: "src/payment.ts",
        symbol: "buildSuccessfulPaymentResponse",
        startLine: 1,
        endLine: 6,
        kind: "function"
      }
    ]);
  });

  it("returns multi-file references for webhook question", async () => {
    const adapter = new FakeCodingAgentAdapter(fixtureWorkspace);
    const result = await adapter.inspect({
      requestId: "req_webhook",
      question: "How does a webhook eventually produce the successful payment response?"
    });

    expect(result.references.map((ref) => ref.file).sort()).toEqual([
      "src/payment.ts",
      "src/webhook.ts"
    ]);
  });
});
