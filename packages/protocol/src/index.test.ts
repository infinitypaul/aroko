import { describe, expect, it } from "vitest";
import {
  A2ATaskReferenceSchema,
  AgentIdSchema,
  CapabilityIdSchema,
  DeveloperIdSchema,
  DeviceIdSchema,
  PAIRMESH_METADATA_VERSION,
  PairMeshAgentSchema,
  PairMeshDeveloperSchema,
  PairMeshMetadataVersionSchema,
  PairMeshProjectSchema,
  PairMeshSessionParticipantSchema,
  PairMeshSessionSchema,
  PermissionDecisionSchema,
  PermissionRequestIdSchema,
  PROTOCOL_INVARIANTS,
  ProjectIdSchema,
  SessionIdSchema
} from "./index.js";

describe("protocol invariants", () => {
  it("preserves MCP/A2A boundary decisions", () => {
    expect(PROTOCOL_INVARIANTS.mcpIsClientBoundary).toBe(true);
    expect(PROTOCOL_INVARIANTS.a2aIsNativeInterAgentProtocol).toBe(true);
    expect(PROTOCOL_INVARIANTS.noProprietaryTaskMessageSemantics).toBe(true);
    expect(PROTOCOL_INVARIANTS.pairmeshSessionIsNotA2aTask).toBe(true);
  });
});

describe("identifier schemas", () => {
  const uuid = "018f7b8a-4f31-7cc5-9a7c-fd3394f4afed";

  it("accepts valid identifiers with correct prefixes", () => {
    expect(DeveloperIdSchema.parse(`dev_${uuid}`)).toBe(`dev_${uuid}`);
    expect(AgentIdSchema.parse(`agt_${uuid}`)).toBe(`agt_${uuid}`);
    expect(SessionIdSchema.parse(`ses_${uuid}`)).toBe(`ses_${uuid}`);
    expect(DeviceIdSchema.parse(`devc_${uuid}`)).toBe(`devc_${uuid}`);
    expect(ProjectIdSchema.parse(`prj_${uuid}`)).toBe(`prj_${uuid}`);
    expect(PermissionRequestIdSchema.parse(`perm_${uuid}`)).toBe(`perm_${uuid}`);
  });

  it("rejects malformed prefixes and random values", () => {
    expect(() => DeveloperIdSchema.parse(`agt_${uuid}`)).toThrow();
    expect(() => AgentIdSchema.parse("agt_not-a-uuid")).toThrow();
    expect(() => SessionIdSchema.parse("ses_123")).toThrow();
  });
});

describe("developer schema", () => {
  const developerId = "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed";

  it("accepts valid developer metadata", () => {
    const parsed = PairMeshDeveloperSchema.parse({
      id: developerId,
      displayName: "Paul",
      handle: "paul-dev"
    });
    expect(parsed.id).toBe(developerId);
  });

  it("rejects missing required fields and unknown fields", () => {
    expect(() => PairMeshDeveloperSchema.parse({ id: developerId })).toThrow();
    expect(() =>
      PairMeshDeveloperSchema.parse({
        id: developerId,
        displayName: "Paul",
        email: "paul@example.com"
      })
    ).toThrow();
  });
});

describe("agent schema", () => {
  it("accepts valid references and extensible adapter IDs", () => {
    const parsed = PairMeshAgentSchema.parse({
      id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      developerId: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      name: "Cursor Local Agent",
      adapter: "vendor.cursor",
      a2aAgentCardUrl: "https://example.com/agent-card"
    });
    expect(parsed.adapter).toBe("vendor.cursor");
  });

  it("rejects malformed identifiers", () => {
    expect(() =>
      PairMeshAgentSchema.parse({
        id: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        developerId: "dev_invalid",
        deviceId: "devc_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        projectId: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        name: "Cursor Local Agent",
        adapter: "vendor.cursor"
      })
    ).toThrow();
  });
});

describe("session and participant schemas", () => {
  it("accepts valid session and participant metadata", () => {
    const session = PairMeshSessionSchema.parse({
      id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      createdAt: "2026-08-19T18:00:00.000Z",
      status: "active"
    });
    expect(session.status).toBe("active");

    const participant = PairMeshSessionParticipantSchema.parse({
      id: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      sessionId: session.id,
      developerId: session.createdBy,
      agentId: "agt_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      joinedAt: "2026-08-19T18:05:00.000Z"
    });
    expect(participant.sessionId).toBe(session.id);
  });

  it("rejects invalid status and non-UTC timestamps", () => {
    expect(() =>
      PairMeshSessionSchema.parse({
        id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        createdAt: "2026-08-19T18:00:00.000+02:00",
        status: "active"
      })
    ).toThrow();

    expect(() =>
      PairMeshSessionSchema.parse({
        id: "ses_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        createdBy: "dev_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        createdAt: "2026-08-19T18:00:00.000Z",
        status: "expired"
      })
    ).toThrow();
  });
});

describe("permissions and versions", () => {
  it("validates capability IDs and permission decisions", () => {
    expect(CapabilityIdSchema.parse("repository.inspect")).toBe("repository.inspect");
    expect(() => CapabilityIdSchema.parse("ask")).toThrow();

    const decision = PermissionDecisionSchema.parse({
      requestId: "perm_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
      capability: "repository.inspect",
      decision: "allow-once",
      decidedAt: "2026-08-19T18:10:00.000Z"
    });
    expect(decision.decision).toBe("allow-once");

    expect(() =>
      PermissionDecisionSchema.parse({
        requestId: "perm_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        capability: "repository.inspect",
        decision: "allow-always",
        decidedAt: "2026-08-19T18:10:00.000Z"
      })
    ).toThrow();
  });

  it("accepts supported metadata version and rejects unsupported", () => {
    expect(PairMeshMetadataVersionSchema.parse(PAIRMESH_METADATA_VERSION)).toBe("0.1.0");
    expect(() => PairMeshMetadataVersionSchema.parse("0.2.0")).toThrow();
  });
});

describe("A2A references and privacy invariants", () => {
  it("models A2A references without cloning A2A schemas", () => {
    const ref = A2ATaskReferenceSchema.parse({
      a2aTaskId: "task-42",
      agent: { a2aAgentCardUrl: "https://peer.example/agent-card" }
    });
    expect(ref.a2aTaskId).toBe("task-42");
  });

  it("rejects local filesystem path fields in shared project metadata", () => {
    expect(() =>
      PairMeshProjectSchema.parse({
        id: "prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4afed",
        name: "payments-api",
        localPath: "/Users/dev/repo"
      })
    ).toThrow();
  });
});
