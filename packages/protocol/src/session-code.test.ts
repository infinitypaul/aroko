import { randomBytes } from "node:crypto";
import { generateSessionCode, SessionCodeSchema } from "./session-code.js";
import { describe, expect, it } from "vitest";

describe("SessionCodeSchema", () => {
  it("accepts valid session codes", () => {
    expect(SessionCodeSchema.parse("PM-X72K8Q")).toBe("PM-X72K8Q");
  });

  it("rejects malformed session codes", () => {
    expect(() => SessionCodeSchema.parse("PM-X72K8")).toThrow();
    expect(() => SessionCodeSchema.parse("pm-x72k8q")).toThrow();
    expect(() => SessionCodeSchema.parse("PM-0O1ILX")).toThrow();
    expect(() => SessionCodeSchema.parse("ABC-X72K8Q")).toThrow();
  });

  it("generates uppercase codes without ambiguous characters", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = generateSessionCode(randomBytes(8));
      expect(code).toMatch(/^PM-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      codes.add(code);
    }
    expect(codes.size).toBeGreaterThan(150);
  });
});
