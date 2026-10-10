import { describe, expect, it } from "vitest";
import type { ServerContext } from "@modelcontextprotocol/server";
import { emitSafeProgressIfSupported } from "./progress.js";

describe("emitSafeProgressIfSupported", () => {
  it("no-ops when the client did not supply a progressToken", async () => {
    const notify = async () => {
      throw new Error("should not notify");
    };
    const ctx = {
      mcpReq: {
        _meta: {},
        notify
      }
    } as unknown as ServerContext;

    await expect(
      emitSafeProgressIfSupported(ctx, { progress: 1, message: "Peer reachable." })
    ).resolves.toBe(false);
  });

  it("notifies with safe message text when progressToken is present", async () => {
    const calls: unknown[] = [];
    const ctx = {
      mcpReq: {
        _meta: { progressToken: "tok-1" },
        notify: async (notification: unknown) => {
          calls.push(notification);
        }
      }
    } as unknown as ServerContext;

    await expect(
      emitSafeProgressIfSupported(ctx, {
        progress: 2,
        total: 4,
        message: "Kelvin's coding agent started inspecting."
      })
    ).resolves.toBe(true);

    expect(calls).toEqual([
      {
        method: "notifications/progress",
        params: {
          progressToken: "tok-1",
          progress: 2,
          total: 4,
          message: "Kelvin's coding agent started inspecting."
        }
      }
    ]);
  });
});
