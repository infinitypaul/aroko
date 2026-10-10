import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJoinCommand } from "@pairmesh/client";
import { cliBinaryLabel, productDisplayName } from "./cli-brand.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("S23-7I public product experience", () => {
  it("uses Aroko product display name", () => {
    expect(productDisplayName()).toBe("Aroko");
  });

  it("defaults CLI suggestions to aroko", () => {
    process.env.AROKO_CLI_NAME = "aroko";
    delete process.env.PAIRMESH_CLI_NAME;
    expect(cliBinaryLabel()).toBe("aroko");
  });

  it("emits aroko join in invite share strings", () => {
    const invite = createJoinCommand({
      sessionCode: "PM-TEST01",
      inviteSecret: "secret"
    });
    expect(invite.joinCommand.startsWith("aroko join ")).toBe(true);
    expect(invite.joinCommand.includes("pairmesh join")).toBe(false);
  });

  it("connect.ts uses Aroko branding and aroko suggestions", () => {
    const src = readFileSync(join(here, "commands/connect.ts"), "utf8");
    expect(src).toContain("productDisplayName");
    expect(src).toContain("What would you like to do?");
    expect(src).toContain("Start a collaboration");
    expect(src).not.toMatch(/PairMesh connect/);
    expect(src).not.toMatch(/Start PairMesh now/);
    expect(src).not.toMatch(/`pairmesh start`/);
    expect(src).not.toMatch(/Widen later with: pairmesh/);
  });

  it("init next steps prefer connect over manual start choreography", () => {
    const src = readFileSync(join(here, "commands/init.ts"), "utf8");
    expect(src).toContain("${bin} connect");
    expect(src).not.toMatch(/\$\{bin\} start`\s*;\s*\n\s*return/);
  });
});
