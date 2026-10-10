import { describe, expect, it } from "vitest";
import { parseArgs, requireFlag } from "../args.js";

describe("join command arguments", () => {
  it("captures the peer url and invite secret", () => {
    const parsed = parseArgs([
      "join",
      "PM-ABC234",
      "--peer",
      "http://100.64.0.2:47100",
      "--invite",
      "s3cret-invite-value"
    ]);

    expect(parsed.command).toBe("join");
    expect(parsed.positionals[0]).toBe("PM-ABC234");
    expect(requireFlag(parsed.flags, "peer")).toBe("http://100.64.0.2:47100");
    expect(requireFlag(parsed.flags, "invite")).toBe("s3cret-invite-value");
  });

  it("fails when the invite secret is missing", () => {
    const parsed = parseArgs(["join", "PM-ABC234", "--peer", "http://100.64.0.2:47100"]);
    expect(() => requireFlag(parsed.flags, "invite")).toThrow(/--invite/);
  });
});

describe("peer command arguments", () => {
  it("parses the remove subcommand and peer name", () => {
    const parsed = parseArgs(["peer", "remove", "kelvin-agent"]);

    expect(parsed.command).toBe("peer");
    expect(parsed.subcommand).toBe("remove");
    expect(parsed.positionals[0]).toBe("kelvin-agent");
  });
});

describe("claude command arguments", () => {
  it("parses setup subcommand and --write flag", () => {
    const parsed = parseArgs(["claude", "setup", "--write"]);

    expect(parsed.command).toBe("claude");
    expect(parsed.subcommand).toBe("setup");
    expect(parsed.flags.write).toBe("true");
    expect(parsed.positionals).toEqual([]);
  });
});
