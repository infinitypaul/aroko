import { describe, expect, it } from "vitest";
import {
  PAIRMESH_METADATA_VERSION,
  PAIRMESH_ERROR_CODES,
  PairMeshDeveloperSchema,
  PairMeshErrorCodeSchema,
  PairMeshErrorSchema,
  PairMeshSessionSchema,
  parsePairMeshMetadata,
  validatePairMeshMetadataVersion
} from "./index.js";

describe("PairMesh error codes", () => {
  it("accepts known PairMesh-owned codes", () => {
    expect(PairMeshErrorCodeSchema.parse("pairmesh.permission_denied")).toBe(
      "pairmesh.permission_denied"
    );
  });

  it("rejects malformed or non-namespaced codes", () => {
    expect(() => PairMeshErrorCodeSchema.parse("permission_denied")).toThrow();
    expect(() => PairMeshErrorCodeSchema.parse("pairmesh.a2a_invalid_request")).toThrow();
  });

  it("does not include invented A2A-like PairMesh codes", () => {
    expect(PAIRMESH_ERROR_CODES).not.toContain("pairmesh.a2a_invalid_request");
    expect(PAIRMESH_ERROR_CODES).not.toContain("pairmesh.task_not_found");
  });
});

describe("PairMesh error payload schema", () => {
  it("accepts valid serialized error payloads", () => {
    const parsed = PairMeshErrorSchema.parse({
      code: "pairmesh.unsupported_metadata_version",
      message: "Unsupported PairMesh metadata version.",
      metadataVersion: PAIRMESH_METADATA_VERSION,
      details: {
        expectedVersion: PAIRMESH_METADATA_VERSION,
        receivedVersion: "0.2.0"
      }
    });
    expect(parsed.code).toBe("pairmesh.unsupported_metadata_version");
  });

  it("rejects unknown fields and invalid details", () => {
    expect(() =>
      PairMeshErrorSchema.parse({
        code: "pairmesh.invalid_metadata",
        message: "Invalid metadata",
        stack: "boom"
      })
    ).toThrow();

    expect(() =>
      PairMeshErrorSchema.parse({
        code: "pairmesh.invalid_metadata",
        message: "Invalid metadata",
        details: {
          localPath: "/home/kelvin/company-secret/payment-service"
        }
      })
    ).toThrow();
  });
});

describe("validation boundary helpers", () => {
  it("maps malformed developer metadata to pairmesh.invalid_metadata", () => {
    const result = parsePairMeshMetadata(PairMeshDeveloperSchema, {
      id: "dev_invalid",
      displayName: "Paul"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("pairmesh.invalid_metadata");
      expect(result.error).not.toHaveProperty("stack");
    }
  });

  it("maps malformed session metadata to pairmesh.invalid_metadata", () => {
    const result = parsePairMeshMetadata(PairMeshSessionSchema, {
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "not-a-date",
      status: "active"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("pairmesh.invalid_metadata");
    }
  });

  it("does not expose absolute local paths from rejected payloads", () => {
    const result = parsePairMeshMetadata(PairMeshDeveloperSchema, {
      id: "dev_invalid",
      displayName: "Paul",
      localPath: "/home/kelvin/company-secret/payment-service"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).not.toContain(
        "/home/kelvin/company-secret/payment-service"
      );
    }
  });
});

describe("metadata version validation", () => {
  it("accepts supported metadata version", () => {
    const result = validatePairMeshMetadataVersion(PAIRMESH_METADATA_VERSION);
    expect(result.ok).toBe(true);
  });

  it("returns unsupported_metadata_version for unsupported but well-formed version", () => {
    const result = validatePairMeshMetadataVersion("0.2.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("pairmesh.unsupported_metadata_version");
    }
  });

  it("returns invalid_metadata for malformed version field", () => {
    const result = validatePairMeshMetadataVersion({ value: "0.1.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("pairmesh.invalid_metadata");
    }
  });
});
