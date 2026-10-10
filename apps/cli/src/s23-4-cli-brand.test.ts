/**
 * S23-4 CLI brand detection and dual-bin metadata.
 */
import { describe, expect, it } from "vitest";
import { detectCliInvocationName, productDisplayName } from "./cli-brand.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

describe("S23-4 CLI branding", () => {
  it("product display name is Aroko", () => {
    expect(productDisplayName()).toBe("Aroko");
  });

  it("detects pairmesh vs aroko invocation", () => {
    expect(detectCliInvocationName("/usr/local/bin/aroko", "node")).toBe("aroko");
    expect(detectCliInvocationName("/usr/local/bin/pairmesh", "node")).toBe("pairmesh");
  });

  it("declares dual bins in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(resolve(import.meta.dirname, ".."), "package.json"), "utf8")
    ) as { bin: Record<string, string> };
    expect(pkg.bin.aroko).toBe("./dist/index.js");
    expect(pkg.bin.pairmesh).toBe("./dist/index.js");
  });
});
