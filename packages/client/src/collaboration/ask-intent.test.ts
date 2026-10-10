import { describe, expect, it } from "vitest";
import {
  classifyCollaborateIntent,
  formatAmbiguousPeerChoices,
  formatAmbiguousPeerPrompt,
  formatRequesterProgressLine,
  resolveCollaborateIntent
} from "./index.js";

describe("Stage 16 Prompt 5 collaborate intent", () => {
  it("classifies inspect-only natural requests", () => {
    expect(classifyCollaborateIntent("Check why payment retries lose the reference").intent).toBe(
      "inspect"
    );
    expect(classifyCollaborateIntent("Investigate the auth regression").intent).toBe("inspect");
    expect(classifyCollaborateIntent("Why does checkout fail?").intent).toBe("inspect");
  });

  it("classifies explicit propose language", () => {
    expect(classifyCollaborateIntent("Fix the retry reference bug").intent).toBe("propose");
    expect(classifyCollaborateIntent("Suggest a fix for the payment retry").intent).toBe("propose");
  });

  it("clarifies when inspect and propose language are mixed (no silent mutation)", () => {
    const result = classifyCollaborateIntent("Check why this fails and fix it");
    expect(result.intent).toBe("clarify");
    expect(result.reason).toMatch(/inspect|propose/i);
  });

  it("resolveCollaborateIntent respects force flags", () => {
    expect(resolveCollaborateIntent({ request: "fix it", force: "inspect" })).toEqual({
      intent: "inspect"
    });
    expect(resolveCollaborateIntent({ request: "check why", force: "propose" })).toEqual({
      intent: "propose"
    });
    expect(resolveCollaborateIntent({ request: "install it", force: "goal" })).toEqual({
      intent: "goal"
    });
  });
});

describe("Stage 16 Prompt 5 peer disambiguation presentation", () => {
  it("formats human-readable ambiguous choices", () => {
    const choices = formatAmbiguousPeerChoices([
      {
        displayName: "Kelvin",
        service: "payment-service",
        participantId: "peer_a"
      },
      {
        displayName: "Kelvin",
        service: "billing-service",
        participantId: "peer_b"
      }
    ]);
    expect(choices.map((c) => c.label)).toEqual([
      "Kelvin · payment-service",
      "Kelvin · billing-service"
    ]);
    const prompt = formatAmbiguousPeerPrompt(choices);
    expect(prompt).toContain("I found 2 matches");
    expect(prompt).toContain("1. Kelvin · payment-service");
    expect(prompt).toContain("Which one?");
    expect(prompt).not.toMatch(/peer_/);
  });
});

describe("Stage 17 Prompt 5 requester progress lines", () => {
  it("renders requester-safe human progress without opaque ids or owner detail", () => {
    expect(
      formatRequesterProgressLine({ phase: "investigating", peerLabel: "Kelvin · payment-service" })
    ).toBe("Investigating");
    expect(
      formatRequesterProgressLine({
        phase: "awaiting_owner_approval",
        peerLabel: "Kelvin"
      })
    ).toBe("Waiting for Kelvin's approval");
    expect(formatRequesterProgressLine({ phase: "applying" })).toBe("Applying");
    expect(formatRequesterProgressLine({ phase: "running_named_tests" })).toBe("Testing");
    expect(formatRequesterProgressLine({ phase: "completed" })).toBe("Completed");
    expect(
      formatRequesterProgressLine({
        phase: "proposal_preparing",
        message: "Reading src/retry.ts"
      })
    ).toBe("Preparing change…");
  });
});
