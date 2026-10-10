import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RECEIVER_ACTIVITY_LIMIT, summarizeOwnerActivity } from "@pairmesh/client";
import type { ProgressEvent } from "@pairmesh/protocol";

/**
 * Stage 17 Prompt 6 — receiver MCP remains 4 read-only tools; show_request projects
 * bounded owner activity. Functional projection tested via summarizeOwnerActivity
 * (same helper wired into receiver-tools).
 */
describe("Stage 17 Prompt 6 — receiver MCP activity awareness", () => {
  it("keeps exactly four receiver tools and no approve/deny/apply/grant", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "receiver-tools.ts"), "utf8");
    const registered = [...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(registered).toEqual([
      "pairmesh_list_requests",
      "pairmesh_show_request",
      "pairmesh_show_proposal",
      "pairmesh_open_inbox"
    ]);
    expect(source).not.toMatch(/registerTool\(\s*"pairmesh_approve/);
    expect(source).not.toMatch(/registerTool\(\s*"pairmesh_deny/);
    expect(source).not.toMatch(/registerTool\(\s*"pairmesh_grant/);
    expect(source).not.toMatch(/registerTool\(\s*"pairmesh_request_apply/);
    expect(source).not.toMatch(/registerTool\(\s*"pairmesh_propose_change/);
    expect(source).toContain("summarizeOwnerActivity");
    expect(source).toContain("activityLimit");
    expect(source).toContain("Does not approve");
  });

  it("show_request-shaped payload includes file.read / search and stays bounded", () => {
    const progress: ProgressEvent[] = Array.from({ length: 30 }, (_, i) => ({
      operationId: "act_recv",
      phase: "reading_searching" as const,
      visibility: "owner_only" as const,
      timestamp: "2026-08-27T12:00:00.000Z",
      activityKind: "file.read" as const,
      sequence: i,
      providerEventId: `f-${i}`,
      safeMetadata: { relativePath: `src/file-${i}.ts` }
    }));
    progress.push({
      operationId: "act_recv",
      phase: "proposal_ready",
      visibility: "requester_safe",
      timestamp: "2026-08-27T12:00:01.000Z",
      activityKind: "proposal.ready",
      sequence: 30,
      providerEventId: "ready"
    });

    const summary = summarizeOwnerActivity({
      progress,
      status: "approval_required",
      needsApproval: true
    });

    expect(summary.activity.length).toBeLessThanOrEqual(DEFAULT_RECEIVER_ACTIVITY_LIMIT);
    expect(summary.activityTruncated).toBe(true);
    expect(summary.proposalReady).toBe(true);
    expect(summary.reviewRequired).toBe(true);
    expect(summary.activity.some((a) => a.activityKind === "file.read")).toBe(true);
    expect(summary.activity.at(-1)?.label).toBe("Waiting for approval");
    expect(JSON.stringify(summary)).not.toContain("chainOfThought");
  });
});
