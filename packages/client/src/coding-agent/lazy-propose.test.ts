import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, PeerIdSchema } from "@pairmesh/protocol";
import { LazyCodingAgentAdapter } from "./lazy-adapter.js";
import { FakeCodingAgentAdapter } from "./fake-adapter.js";
import { CodingAgentProposalGenerator } from "../action/proposal/coding-agent-generator.js";

/**
 * Prompt 7 regression: A2A change.propose uses LazyCodingAgentAdapter.
 * The lazy wrapper must forward proposeChange to the resolved provider.
 */
describe("Stage 15 Prompt 7 — LazyCodingAgentAdapter proposeChange forward", () => {
  it("forwards proposeChange through Lazy + CodingAgentProposalGenerator", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-lazy-propose-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src/retry.ts"),
      [
        "export type RetryRecord = { reference: string; customerId?: string | null };",
        "export function rebuildPaymentFromRetryRecord(retryRecord: RetryRecord) {",
        "  return {",
        '    reference: `retry:${retryRecord.customerId ?? "unknown"}`,',
        "    customerId: retryRecord.customerId ?? null",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const lazy = new LazyCodingAgentAdapter(new FakeCodingAgentAdapter(workspace));
    expect(typeof lazy.proposeChange).toBe("function");

    const generator = new CodingAgentProposalGenerator(lazy);
    const draft = await generator.generate({
      instruction: "Fix payment retry reference reconstruction.",
      actionId: ActionIdSchema.parse("act_018f7b8a-4f31-7cc5-9a7c-fd3394f4af99"),
      requesterParticipantId: PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01"),
      targetParticipantId: PeerIdSchema.parse("peer_018f7b8a-4f31-7cc5-9a7c-fd3394f4af02"),
      workspaceRoot: workspace
    });

    expect(draft.unifiedDiff).toContain("retryRecord.reference");
    expect(lazy.provider.capabilities.proposeChange).toBe(true);
    expect(lazy.provider.id).toBe("fake");
  });
});
