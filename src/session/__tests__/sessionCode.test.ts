import { describe, it, expect } from "vitest";
import { generateSessionCode } from "../sessionCode.js";

const AMBIGUOUS = /[01OIL]/;

describe("generateSessionCode", () => {
  it("returns a string matching the format XXX-XXX", () => {
    const code = generateSessionCode();
    expect(code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  });

  it("never contains ambiguous characters (0, O, 1, I, L) across 100 iterations", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateSessionCode();
      expect(AMBIGUOUS.test(code)).toBe(false);
    }
  });

  it("generates 1000 unique codes with no duplicates", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateSessionCode());
    }
    expect(codes.size).toBe(1000);
  });
});
