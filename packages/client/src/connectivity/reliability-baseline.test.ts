/**
 * Stage 18 Prompt 5 — local multi-process baseline samples (preliminary).
 * Not Paul/Kelvin/Sarah multi-Mac. Uses HostedPairMeshRelay on loopback.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveRelayAccessToken,
  HostedPairMeshRelay,
  PairMeshRelayClient,
  createRelaySessionId
} from "./index.js";
import {
  resetReliabilityTrackerForTest,
  summarizeDurations,
  type ReliabilityMetricRecord
} from "../reliability/index.js";

describe("Stage 18 Prompt 5 — local relay baseline (preliminary)", () => {
  const relays: HostedPairMeshRelay[] = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((r) => r.close()));
  });

  it("samples socket→attached on local hosted relay (n=5)", async () => {
    const emitted: ReliabilityMetricRecord[] = [];
    resetReliabilityTrackerForTest({
      emit: (r) => emitted.push(r)
    });

    const relay = new HostedPairMeshRelay({ idleTimeoutMs: 60_000 });
    relays.push(relay);
    const { port } = await relay.listen("127.0.0.1", 0);
    const relayWsUrl = `ws://127.0.0.1:${port}/relay`;
    const sessionCode = "PM-BASE05";
    const inviteSecret = "inv_baseline_prompt5_secret_value";
    const relaySessionId = createRelaySessionId(randomBytes);
    const token = deriveRelayAccessToken({
      inviteSecret,
      sessionCode,
      relaySessionId
    });
    relay.createSession({ accessToken: token, relaySessionId });

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      emitted.length = 0;
      const client = new PairMeshRelayClient({
        relayUrl: relayWsUrl,
        relaySessionId,
        relayAccessToken: token,
        fromParticipantId: `baseline_${i}`
      });
      await client.connect();
      const attach = emitted.find(
        (e) => e.metric === "relay.socket_to_attached" && e.outcome === "success"
      );
      expect(attach).toBeDefined();
      samples.push(attach!.durationMs);
      await client.close();
    }

    const stats = summarizeDurations(samples);
    expect(stats.count).toBe(5);
    expect(stats.min).toBeGreaterThanOrEqual(0);
    expect(stats.max).toBeGreaterThanOrEqual(stats.min);
    console.log(
      JSON.stringify({
        environment: "local_multi_process",
        metric: "relay.socket_to_attached",
        preliminary: true,
        samples,
        min: stats.min,
        median: stats.median,
        max: stats.max
      })
    );
  }, 60_000);
});
