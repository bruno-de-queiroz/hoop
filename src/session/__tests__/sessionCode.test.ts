import { describe, it, expect } from "vitest";
import { generateSessionCode, validateSessionCode } from "../sessionCode.js";

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

describe("validateSessionCode", () => {
  it("returns true for a valid code", () => {
    expect(validateSessionCode("ABC-XYZ")).toBe(true);
  });

  it("returns true for a code produced by generateSessionCode", () => {
    const code = generateSessionCode();
    expect(validateSessionCode(code)).toBe(true);
  });

  it("returns false for wrong length", () => {
    expect(validateSessionCode("AB-XYZ")).toBe(false);
    expect(validateSessionCode("ABCD-XYZ")).toBe(false);
    expect(validateSessionCode("ABC-XYZW")).toBe(false);
  });

  it("returns false when the dash is missing", () => {
    expect(validateSessionCode("ABCXYZ7")).toBe(false);
  });

  it("returns false for lowercase characters", () => {
    expect(validateSessionCode("abc-XYZ")).toBe(false);
    expect(validateSessionCode("ABC-xyz")).toBe(false);
  });

  it("returns false for ambiguous characters (0, O, 1, I, L)", () => {
    expect(validateSessionCode("0BC-XYZ")).toBe(false);
    expect(validateSessionCode("OBC-XYZ")).toBe(false);
    expect(validateSessionCode("1BC-XYZ")).toBe(false);
    expect(validateSessionCode("IBC-XYZ")).toBe(false);
    expect(validateSessionCode("LBC-XYZ")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(validateSessionCode("")).toBe(false);
  });
});
