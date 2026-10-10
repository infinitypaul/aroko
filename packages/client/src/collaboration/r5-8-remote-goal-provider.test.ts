import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectIdSchema } from "@pairmesh/protocol";
import { resolveRemoteGoalProviderId } from "./task-remote-handler.js";

describe("R5-8 remote goal provider resolution", () => {
  it("defaults to fake when no workspace / override", async () => {
    expect(await resolveRemoteGoalProviderId({})).toBe("fake");
  });

  it("honors explicit override", async () => {
    expect(
      await resolveRemoteGoalProviderId({
        workspaceRoot: "/tmp",
        override: "claude-code"
      })
    ).toBe("claude-code");
  });

  it("reads codingAgent.provider from receiver .pairmesh/config.json", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pairmesh-r58-provider-"));
    await mkdir(join(workspace, ".pairmesh"), { recursive: true });
    const projectId = ProjectIdSchema.parse("prj_018f7b8a-4f31-7cc5-9a7c-fd3394f4af01");
    await writeFile(
      join(workspace, ".pairmesh", "config.json"),
      `${JSON.stringify(
        {
          configVersion: "0.1.0",
          projectId,
          agent: { name: "test-agent", port: "auto" },
          workspace,
          codingAgent: { provider: "claude-code", mode: "ask" },
          connectivity: { mode: "relay" }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    expect(await resolveRemoteGoalProviderId({ workspaceRoot: workspace })).toBe("claude-code");
  });
});
