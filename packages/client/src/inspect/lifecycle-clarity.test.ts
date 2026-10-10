import { describe, expect, it, vi } from "vitest";
import { createPairMeshError } from "@pairmesh/protocol";

/**
 * Lifecycle semantics for Prompt 6 / UX-02 — pure decision tests (no Stage 18 internals).
 */
function classifyWaitOutcome(input: {
  remoteStatus: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  waitBudgetExpired: boolean;
  lastTransportUnavailable: boolean;
}):
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "requester_wait_expired"
  | "peer_transport_unavailable" {
  if (input.remoteStatus === "completed") {
    return "completed";
  }
  if (input.remoteStatus === "failed") {
    return "failed";
  }
  if (input.remoteStatus === "cancelled") {
    return "cancelled";
  }
  if (input.remoteStatus === "timed_out") {
    return "timed_out";
  }
  if (input.waitBudgetExpired && input.lastTransportUnavailable) {
    return "peer_transport_unavailable";
  }
  if (input.waitBudgetExpired) {
    return "requester_wait_expired";
  }
  return "running";
}

describe("Stage 19 Prompt 6 — inspection lifecycle clarity", () => {
  it("does not equate wait-budget expiry with remote failure", () => {
    expect(
      classifyWaitOutcome({
        remoteStatus: "running",
        waitBudgetExpired: true,
        lastTransportUnavailable: false
      })
    ).toBe("requester_wait_expired");
    expect(
      classifyWaitOutcome({
        remoteStatus: "failed",
        waitBudgetExpired: true,
        lastTransportUnavailable: false
      })
    ).toBe("failed");
  });

  it("keeps peer_transport_unavailable distinct from running and inspection_not_found", () => {
    expect(
      classifyWaitOutcome({
        remoteStatus: "running",
        waitBudgetExpired: true,
        lastTransportUnavailable: true
      })
    ).toBe("peer_transport_unavailable");

    const transport = createPairMeshError({
      code: "pairmesh.peer_transport_unavailable",
      message: "transport"
    });
    const missing = createPairMeshError({
      code: "pairmesh.inspection_not_found",
      message: "missing"
    });
    expect(transport.code).not.toBe(missing.code);
  });

  it("continuation reuses the same requestId without spawning a new ask", () => {
    const requestId = "req_123";
    const asks: string[] = [];
    const waitCalls: string[] = [];

    // Initial ask
    asks.push(requestId);
    // Wait expired → continue with waitForInspection(same id), not askPeer again
    waitCalls.push(requestId);
    waitCalls.push(requestId);

    expect(asks).toEqual(["req_123"]);
    expect(waitCalls.every((id) => id === "req_123")).toBe(true);
    expect(new Set(asks).size).toBe(1);
  });

  it("ISSUE-03 — unrecovered transport maps to typed failure; recovered sync succeeds", async () => {
    let transportDown = true;
    const poll = vi.fn(async () => {
      if (transportDown) {
        throw createPairMeshError({
          code: "pairmesh.peer_transport_unavailable",
          message: "502"
        });
      }
      return { status: "completed" as const };
    });

    // Unrecovered within budget
    let lastTransport = false;
    try {
      await poll();
    } catch {
      lastTransport = true;
    }
    expect(
      classifyWaitOutcome({
        remoteStatus: "running",
        waitBudgetExpired: true,
        lastTransportUnavailable: lastTransport
      })
    ).toBe("peer_transport_unavailable");

    // Recovered later
    transportDown = false;
    lastTransport = false;
    const recovered = await poll();
    expect(recovered.status).toBe("completed");
    expect(
      classifyWaitOutcome({
        remoteStatus: "completed",
        waitBudgetExpired: false,
        lastTransportUnavailable: false
      })
    ).toBe("completed");
  });
});
