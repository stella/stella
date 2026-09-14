import { describe, expect, test } from "bun:test";

import { validate as validateRegon } from "@stll/stdnum/pl/regon";

import { normalizeRegon } from "./regon.js";

describe("normalizeRegon", () => {
  test.each([
    ["49270733300000", "492707333"],
    ["01206414300000", "012064143"],
    ["14133403900000", "141334039"],
    // Padding whose fourteen-digit form satisfies the check digit anyway: the
    // checksum cannot decide this, the all-zero unit segment does.
    ["35052737700000", "350527377"],
  ])("unpads the KRS-padded REGON %s", (padded, base) => {
    expect(normalizeRegon(padded)).toBe(base);
    expect(validateRegon(base).valid).toBe(true);
    expect(normalizeRegon(base)).toBe(base);
  });

  test.each([
    // Already nine digits.
    "381131103",
    // Fourteen digits carrying a real local-unit segment.
    "49270733312345",
    "49270733300017",
    // Malformed or foreign.
    "",
    "12345",
    "4927073330000",
    "492707333000000",
    "REGON492707333",
    "4927073330000a",
    " 49270733300000",
  ])("leaves %s untouched", (regon) => {
    expect(normalizeRegon(regon)).toBe(regon);
  });

  test("leaves a padded value alone when the base fails its check digit", () => {
    expect(validateRegon("492707334").valid).toBe(false);
    expect(normalizeRegon("49270733400000")).toBe("49270733400000");
  });

  test("is idempotent, and only ever drops the five-zero suffix", () => {
    for (let value = 0; value < 100_000; value += 7) {
      const base = String(value).padStart(9, "0");
      const padded = `${base}00000`;
      const once = normalizeRegon(padded);
      expect(normalizeRegon(once)).toBe(once);
      expect(once === padded || once === base).toBe(true);
      expect(once === base).toBe(validateRegon(base).valid);
    }
  });
});
