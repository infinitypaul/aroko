import { describe, expect, it } from "vitest";
import { ProviderMessageAggregator } from "./provider-message-aggregator.js";

describe("Stage 19 ProviderMessageAggregator", () => {
  it("aggregates tiny stream deltas into a sentence-bounded message", () => {
    const agg = new ProviderMessageAggregator();
    const parts = ["I'll", " inspect", " the", " payment", " flow."];
    let flushed: string | undefined;
    for (const part of parts) {
      const result = agg.push(part);
      if (result) {
        flushed = result.text;
      }
    }
    expect(flushed).toBe("I'll inspect the payment flow.");
    expect(agg.flush()).toBeUndefined();
  });

  it("does not emit hundreds of events for hundreds of chunks", () => {
    const agg = new ProviderMessageAggregator({ maxChars: 120, maxChunks: 40 });
    let flushCount = 0;
    for (let i = 0; i < 415; i += 1) {
      const result = agg.push(i % 17 === 0 ? "word. " : "x");
      if (result) {
        flushCount += 1;
      }
    }
    const trailing = agg.flush();
    if (trailing) {
      flushCount += 1;
    }
    expect(flushCount).toBeGreaterThan(0);
    expect(flushCount).toBeLessThan(80);
  });
});
