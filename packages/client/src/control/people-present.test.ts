import { describe, expect, it } from "vitest";
import {
  AUTHORITATIVE_PERMISSIONS,
  buildInviteShareModel,
  buildPeopleListModel,
  buildPersonDetailModel,
  grantPolicyForCapability,
  humanizeJoinError,
  humanizePermissionError,
  isAllowSessionForbidden,
  peopleHtmlContainsForbiddenTech,
  policyOptionsForCapability,
  policyToHumanLabel,
  summarizeAllowedPermissions
} from "../../control-web/people-present.js";

const kelvin = {
  peer: "payment-service-agent",
  participantId: "peer_k",
  displayName: "Kelvin",
  service: "payment-service",
  relationship: "paired",
  connectivity: "ready",
  agent: "ready",
  grants: [
    { capabilityId: "repository.inspect", policy: "allow_session", updatedAt: "t" },
    { capabilityId: "repository.source_references", policy: "allow_session", updatedAt: "t" },
    { capabilityId: "change.propose", policy: "deny", updatedAt: "t" },
    { capabilityId: "repository.edit", policy: "approval_required", updatedAt: "t" },
    { capabilityId: "tests.run", policy: "deny", updatedAt: "t" }
  ]
};

describe("Stage 20 Prompt 3 — People / permissions / connect helpers", () => {
  it("lists six authoritative permissions with human labels", () => {
    expect(AUTHORITATIVE_PERMISSIONS).toHaveLength(6);
    expect(AUTHORITATIVE_PERMISSIONS.map((p) => p.id)).toEqual([
      "repository.inspect",
      "repository.source_references",
      "change.propose",
      "repository.edit",
      "tests.run",
      "process.execute"
    ]);
    expect(AUTHORITATIVE_PERMISSIONS[0]?.label).toBe("Ask questions about my code");
    expect(AUTHORITATIVE_PERMISSIONS[3]?.label).toBe("Apply approved code changes");
    expect(AUTHORITATIVE_PERMISSIONS[4]?.helper).toMatch(/not arbitrary shell/i);
    expect(AUTHORITATIVE_PERMISSIONS[4]?.label).not.toMatch(/shell|command/i);
    expect(AUTHORITATIVE_PERMISSIONS[5]?.id).toBe("process.execute");
    expect(AUTHORITATIVE_PERMISSIONS[5]?.label).toBe("Run commands");
  });

  it("maps policies to human product labels", () => {
    expect(policyToHumanLabel("allow_session")).toBe("Allow");
    expect(policyToHumanLabel("approval_required")).toBe("Ask me each time");
    expect(policyToHumanLabel("deny")).toBe("Don't allow");
  });

  it("never offers Allow for repository.edit", () => {
    const opts = policyOptionsForCapability("repository.edit");
    expect(opts.some((o) => o.policy === "allow_session")).toBe(false);
    expect(opts.map((o) => o.label)).toEqual(["Ask me each time", "Don't allow"]);
    expect(isAllowSessionForbidden("repository.edit", "allow_session")).toBe(true);
    expect(isAllowSessionForbidden("repository.inspect", "allow_session")).toBe(false);
    const processOpts = policyOptionsForCapability("process.execute");
    expect(processOpts.some((o) => o.policy === "allow_session")).toBe(false);
    expect(isAllowSessionForbidden("process.execute", "allow_session")).toBe(true);
  });

  it("builds people list and person detail without URLs", () => {
    const list = buildPeopleListModel([
      kelvin,
      {
        ...kelvin,
        participantId: "peer_gone",
        displayName: "Gone",
        relationship: "unpaired"
      }
    ]);
    expect(list.people).toHaveLength(1);
    expect(list.people[0]?.permissionSummary).toContain("Questions");
    expect(list.people[0]?.permissionSummary).toContain("File references");

    const detail = buildPersonDetailModel(kelvin);
    expect(detail?.permissions).toHaveLength(6);
    const edit = detail?.permissions.find((p) => p.id === "repository.edit");
    expect(edit?.options.some((o) => o.policy === "allow_session")).toBe(false);
    expect(edit?.helper).toMatch(/Approve once/);
    expect(detail?.reciprocalNote).toMatch(/managed on their side/);
    expect(JSON.stringify(detail)).not.toMatch(/agentUrl|127\.0\.0\.1|inviteSecret/);
  });

  it("summarizes and reads grant policies", () => {
    expect(grantPolicyForCapability(kelvin, "repository.edit")).toBe("approval_required");
    expect(summarizeAllowedPermissions(kelvin)).toMatch(/Apply \(with approval\)/);
  });

  it("builds invite share model without elevating raw secret", () => {
    const share = buildInviteShareModel({
      joinCommand: "aroko join PM-TEST --invite SECRET",
      expiresAt: "2026-09-02T12:00:00.000Z",
      inviteSecret: "SECRET",
      sessionCode: "PM-TEST"
    });
    expect(share?.joinCommand).toContain("aroko join");
    expect(share?.singleUse).toBe(true);
    expect(share?.expiresLabel).toBeTruthy();
    expect(Object.keys(share ?? {})).not.toContain("inviteSecret");
  });

  it("humanizes join and permission errors", () => {
    expect(humanizeJoinError("invite expired")).toMatch(/expired/i);
    expect(humanizeJoinError("already used")).toMatch(/already used/i);
    expect(humanizeJoinError("Could not parse join command")).toMatch(/isn't valid/i);
    expect(humanizePermissionError("repository.edit cannot use allow_session")).toMatch(
      /cannot be set to Allow/
    );
  });

  it("flags forbidden technical leakage", () => {
    expect(peopleHtmlContainsForbiddenTech("<div>Ready</div>")).toBe(false);
    expect(peopleHtmlContainsForbiddenTech("inviteSecret=abc")).toBe(true);
    expect(peopleHtmlContainsForbiddenTech("http://127.0.0.1:9")).toBe(true);
  });
});
