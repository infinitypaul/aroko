import { describe, expect, it } from "vitest";
import { enrichActionForControlInbox } from "./action-inbox.js";
import type { ActionSafeView } from "../action/session-bridge.js";

describe("control action inbox enrichment", () => {
  it("adds human labels and provider display name", () => {
    const view: ActionSafeView = {
      actionId: "act_test",
      status: "approval_required",
      actionType: "repository.edit",
      capabilityId: "repository.edit",
      requesterParticipantId: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
      targetParticipantId: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02",
      createdAt: "2026-08-23T12:00:00.000Z",
      updatedAt: "2026-08-23T12:01:00.000Z",
      terminal: false,
      progress: [],
      peer: {
        participantId: "peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01",
        displayName: "Paul",
        service: "payment-service"
      },
      summary: "Apply retry reference fix"
    };
    const enriched = enrichActionForControlInbox(view, { codingAgentProviderId: "claude-code" });
    expect(enriched.actionLabel).toBe("Apply change");
    expect(enriched.providerDisplayName).toBe("Claude Code");
    expect(enriched.requestSummary).toBe("Apply retry reference fix");
    expect(enriched.needsApproval).toBe(true);
    expect(enriched.canApproveOnce).toBe(true);
    expect(enriched.canApproveSession).toBe(false);
  });
});

describe("control web static", () => {
  it("resolves inbox route to index.html", async () => {
    const { resolveControlWebPath } = await import("./web-static.js");
    expect(resolveControlWebPath("inbox")).toMatch(/index\.html$/);
    expect(resolveControlWebPath("")).toMatch(/index\.html$/);
    expect(resolveControlWebPath("../secret")).toBeUndefined();
  });
});

describe("openControlInboxUrl", () => {
  it("builds loopback inbox url with exchange code (not long-lived token)", async () => {
    const { buildControlInboxUrl } = await import("./open-inbox.js");
    const url = buildControlInboxUrl("http://127.0.0.1:4321", "cxc_one-time-code");
    expect(url).toBe("http://127.0.0.1:4321/control/web/#code=cxc_one-time-code");
    expect(url).not.toContain("token=");
  });

  it("includes action and view deep-link params including legacy inbox", async () => {
    const { buildControlInboxUrl, parseControlDeepLinkHash } = await import("./open-inbox.js");
    const url = buildControlInboxUrl("http://127.0.0.1:4321", "cxc_abc", {
      actionId: "act_abc",
      view: "inbox"
    });
    expect(url).toContain("action=act_abc");
    expect(url).toContain("view=inbox");
    expect(url).toContain("code=cxc_abc");
    const parsed = parseControlDeepLinkHash(url.split("#")[1]!);
    expect(parsed.code).toBe("cxc_abc");
    expect(parsed.actionId).toBe("act_abc");
    expect(parsed.view).toBe("inbox");
  });

  it("accepts product Control Center views in deep-link hash", async () => {
    const { parseControlDeepLinkHash } = await import("./open-inbox.js");
    const parsed = parseControlDeepLinkHash("code=cxc_t&view=needs-you&action=act_1");
    expect(parsed.view).toBe("needs-you");
    expect(parsed.actionId).toBe("act_1");
    expect(parsed.code).toBe("cxc_t");
  });
});
