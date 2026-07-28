import { describe, expect, test } from "bun:test";

import { normalizeMbs, validateMbs } from "./validation.js";

describe("Croatian MBS validation", () => {
  test("normalizes whitespace while preserving leading zeroes", () => {
    expect(normalizeMbs("080 000 014")).toBe("080000014");
  });

  test("accepts only nine ASCII digits", () => {
    expect(validateMbs("080000014")).toBe(true);
    expect(validateMbs("80000014")).toBe(false);
    expect(validateMbs("08000001A")).toBe(false);
    expect(validateMbs("٠٨٠٠٠٠٠١٤")).toBe(false);
  });
});
