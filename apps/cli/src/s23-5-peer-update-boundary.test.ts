import { describe, expect, it } from "vitest";
import { assertNoPeerUpdateCapabilities, isForbiddenPeerUpdateCapability } from "@pairmesh/client";
import { PAIRMESH_FUTURE_CAPABILITIES, PAIRMESH_GRANTABLE_CAPABILITIES } from "@pairmesh/protocol";

const MCP_TOOL_NAMES = [
  "pairmesh_status",
  "pairmesh_list_peers",
  "pairmesh_ask",
  "pairmesh_send",
  "pairmesh_ask_peer",
  "pairmesh_follow_up",
  "pairmesh_list_threads",
  "pairmesh_get_thread",
  "pairmesh_close_thread",
  "pairmesh_peer_health",
  "pairmesh_inspection_status",
  "pairmesh_wait_for_inspection",
  "pairmesh_cancel_inspection",
  "pairmesh_propose_change",
  "pairmesh_request_apply",
  "pairmesh_run_tests",
  "pairmesh_execute_process",
  "pairmesh_action_status",
  "pairmesh_wait_for_action",
  "pairmesh_cancel_action"
] as const;

const A2A_SKILL_IDS = [
  "pairmesh.session",
  "pairmesh.inspect",
  "pairmesh.action",
  "pairmesh.task",
  "pairmesh.echo"
] as const;

describe("S23-5 peer cannot trigger software update", () => {
  it("exposes no MCP update/install tools", () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(isForbiddenPeerUpdateCapability(name)).toBe(false);
      expect(name).not.toMatch(/install|upgrade|software\.update|aroko\.update/);
    }
    expect(() => assertNoPeerUpdateCapabilities(MCP_TOOL_NAMES)).not.toThrow();
  });

  it("exposes no grantable update capabilities", () => {
    expect(() => assertNoPeerUpdateCapabilities(PAIRMESH_GRANTABLE_CAPABILITIES)).not.toThrow();
    expect(() => assertNoPeerUpdateCapabilities(PAIRMESH_FUTURE_CAPABILITIES)).not.toThrow();
  });

  it("exposes no A2A update skills", () => {
    for (const id of A2A_SKILL_IDS) {
      expect(id).not.toMatch(/update|upgrade|install/);
    }
    expect(() => assertNoPeerUpdateCapabilities(A2A_SKILL_IDS)).not.toThrow();
  });
});
