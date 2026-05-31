import { describe, expect, test } from "bun:test";

import { normalizeBusinessId, validateBusinessId } from "./validation.js";

describe("normalizeBusinessId", () => {
  test("strips whitespace", () => {
    expect(normalizeBusinessId(" 0112038-9 ")).toBe("0112038-9");
    expect(normalizeBusinessId("0112038-9\n")).toBe("0112038-9");
  });
});

describe("validateBusinessId", () => {
  test("accepts known-valid Finnish business IDs", () => {
    // Nokia Oyj
    expect(validateBusinessId("0112038-9")).toBe(true);
    // Supercell Oy
    expect(validateBusinessId("2336509-6")).toBe(true);
    // PRH itself (Patentti- ja rekisterihallitus)
    expect(validateBusinessId("0244683-1")).toBe(true);
  });

  test("rejects wrong-format strings", () => {
    expect(validateBusinessId("0112038")).toBe(false);
    expect(validateBusinessId("01120389")).toBe(false);
    expect(validateBusinessId("abcdefg-1")).toBe(false);
    expect(validateBusinessId("0112038-X")).toBe(false);
    expect(validateBusinessId("")).toBe(false);
  });

  test("rejects bad checksum", () => {
    expect(validateBusinessId("0112038-0")).toBe(false);
    expect(validateBusinessId("0112038-1")).toBe(false);
    expect(validateBusinessId("0112038-8")).toBe(false);
  });

  test("rejects the MOD-11 remainder-1 case (no possible check digit)", () => {
    // Construct seven digits whose weighted sum mod 11 = 1, then assert
    // EVERY check digit 0-9 is rejected.
    //
    // weights = [7, 9, 10, 5, 8, 4, 2]
    // pick "1000000": 1*7 + 0 + 0 + 0 + 0 + 0 + 0 = 7 → remainder 7 (not 1)
    // pick "0000003": 0 + 0 + 0 + 0 + 0 + 0 + 3*2 = 6 → remainder 6 (not 1)
    // pick "0000006": 6*2 = 12 → remainder 1 ✓
    for (let control = 0; control <= 9; control++) {
      expect(validateBusinessId(`0000006-${control}`)).toBe(false);
    }
  });
});
