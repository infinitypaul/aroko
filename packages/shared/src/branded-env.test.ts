/**
 * S23-4 — branded env precedence and MCP key helpers.
 */
import { describe, expect, it } from "vitest";
import { mcpServerKeysPresent, pickMcpServerEntry, readBrandedEnv } from "./branded-env.js";

describe("S23-4 branded env precedence", () => {
  it("uses AROKO when only AROKO is set", () => {
    expect(
      readBrandedEnv({
        aroko: "AROKO_HOME",
        pairmesh: "PAIRMESH_HOME",
        env: { AROKO_HOME: "/a" }
      })
    ).toBe("/a");
  });

  it("falls back to PAIRMESH when only legacy is set", () => {
    expect(
      readBrandedEnv({
        aroko: "AROKO_HOME",
        pairmesh: "PAIRMESH_HOME",
        env: { PAIRMESH_HOME: "/p" }
      })
    ).toBe("/p");
  });

  it("returns default when neither set", () => {
    expect(
      readBrandedEnv({
        aroko: "AROKO_HOME",
        pairmesh: "PAIRMESH_HOME",
        env: {},
        defaultValue: "/default"
      })
    ).toBe("/default");
  });

  it("prefers AROKO when both set to same value", () => {
    expect(
      readBrandedEnv({
        aroko: "AROKO_HOME",
        pairmesh: "PAIRMESH_HOME",
        env: { AROKO_HOME: "/same", PAIRMESH_HOME: "/same" }
      })
    ).toBe("/same");
  });

  it("prefers AROKO when both conflict", () => {
    expect(
      readBrandedEnv({
        aroko: "AROKO_HOME",
        pairmesh: "PAIRMESH_HOME",
        env: { AROKO_HOME: "/a", PAIRMESH_HOME: "/p" }
      })
    ).toBe("/a");
  });

  it("errors on conflict when policy is error", () => {
    expect(() =>
      readBrandedEnv({
        aroko: "AROKO_HOME",
        pairmesh: "PAIRMESH_HOME",
        env: { AROKO_HOME: "/a", PAIRMESH_HOME: "/p" },
        onConflict: "error"
      })
    ).toThrow(/Conflicting environment variables/);
  });
});

describe("S23-4 MCP server key selection", () => {
  it("prefers aroko when both present", () => {
    const picked = pickMcpServerEntry({
      aroko: { command: "aroko" },
      pairmesh: { command: "pairmesh" }
    });
    expect(picked?.key).toBe("aroko");
    expect(mcpServerKeysPresent({ aroko: {}, pairmesh: {} }).both).toBe(true);
  });

  it("falls back to pairmesh", () => {
    expect(pickMcpServerEntry({ pairmesh: { command: "x" } })?.key).toBe("pairmesh");
  });

  it("returns null when neither", () => {
    expect(pickMcpServerEntry({})).toBeNull();
  });
});
