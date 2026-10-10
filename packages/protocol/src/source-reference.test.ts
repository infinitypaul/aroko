import { describe, expect, it } from "vitest";
import {
  PairMeshSourceReferenceSchema,
  PairMeshSourceReferenceListSchema
} from "./source-reference.js";

describe("PairMeshSourceReferenceSchema", () => {
  it("accepts valid repository-relative references", () => {
    const parsed = PairMeshSourceReferenceSchema.parse({
      file: "src/payment.ts",
      symbol: "buildSuccessfulPaymentResponse",
      startLine: 1,
      endLine: 6,
      kind: "function"
    });
    expect(parsed.file).toBe("src/payment.ts");
  });

  it("rejects absolute unix paths", () => {
    expect(() =>
      PairMeshSourceReferenceSchema.parse({
        file: "/Users/kelvin/project/src/payment.ts"
      })
    ).toThrow();
  });

  it("rejects absolute windows paths", () => {
    expect(() =>
      PairMeshSourceReferenceSchema.parse({
        file: "C:\\Users\\Kelvin\\repo\\src\\payment.ts"
      })
    ).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() =>
      PairMeshSourceReferenceSchema.parse({
        file: "../src/payment.ts"
      })
    ).toThrow();
  });

  it("rejects invalid line ranges", () => {
    expect(() =>
      PairMeshSourceReferenceSchema.parse({
        file: "src/payment.ts",
        startLine: 5,
        endLine: 2
      })
    ).toThrow();
  });

  it("defaults references list to empty array", () => {
    expect(PairMeshSourceReferenceListSchema.parse(undefined)).toEqual([]);
  });
});
