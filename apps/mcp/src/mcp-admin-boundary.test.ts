import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORBIDDEN_ADMIN_TOOLS = [
  "pairmesh_approve",
  "pairmesh_deny",
  "pairmesh_grant",
  "pairmesh_revoke",
  "pairmesh_invite",
  "pairmesh_leave",
  "pairmesh_create_invite",
  "pairmesh_permissions_decide",
  "pairmesh_remove_peer",
  "pairmesh_action_approve",
  "pairmesh_approve_action"
];

const EXPECTED_ACTION_TOOLS = [
  "pairmesh_propose_change",
  "pairmesh_request_apply",
  "pairmesh_run_tests",
  "pairmesh_execute_process",
  "pairmesh_action_status",
  "pairmesh_wait_for_action",
  "pairmesh_cancel_action"
] as const;

describe("MCP human-admin boundary", () => {
  it("does not register approval/invite/leave mutation tools", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "create-server.ts"), "utf8");
    const registered = [...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(registered.length).toBeGreaterThan(5);
    for (const forbidden of FORBIDDEN_ADMIN_TOOLS) {
      expect(registered).not.toContain(forbidden);
    }
    expect(registered).toContain("pairmesh_ask_peer");
    expect(registered).toContain("pairmesh_ask");
    expect(registered).toContain("pairmesh_wait_for_inspection");
    expect(registered).toContain("pairmesh_status");
    for (const tool of EXPECTED_ACTION_TOOLS) {
      expect(registered).toContain(tool);
    }
    expect(registered).not.toContain("pairmesh_approve");
    expect(registered).not.toContain("pairmesh_action_approve");
  });

  it("receiver tool registry has no approve/deny/grant and no requester mutations", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "receiver-tools.ts"), "utf8");
    const registered = [...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(registered).toEqual([
      "pairmesh_list_requests",
      "pairmesh_show_request",
      "pairmesh_show_proposal",
      "pairmesh_open_inbox"
    ]);
    for (const forbidden of FORBIDDEN_ADMIN_TOOLS) {
      expect(registered).not.toContain(forbidden);
    }
    expect(registered).not.toContain("pairmesh_propose_change");
    expect(registered).not.toContain("pairmesh_request_apply");
    expect(registered).not.toContain("pairmesh_ask_peer");
  });
});
