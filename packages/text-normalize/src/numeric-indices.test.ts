import { describe, expect, test } from "bun:test";

import { normalizeNumericIndices } from "./numeric-indices";
import { normalizeUnicode } from "./unicode";

describe("numeric superscript indices", () => {
  // `505⁹` is article 505 with index 9, not article 5059, however its digits
  // are written; compatibility folding afterwards must keep the boundary.
  test.each([
    ["§ 505⁹", "§ 505^9"],
    ["§ ５０５⁹", "§ ５０５^9"],
    ["čl. 10¹²", "čl. 10^12"],
  ])("keeps %p apart from its number", (text, normalized) => {
    expect(normalizeNumericIndices(text)).toBe(normalized);
    expect(normalizeUnicode(normalizeNumericIndices(text), "NFKC")).toBe(
      normalizeUnicode(normalized, "NFKC"),
    );
  });

  test("leaves a superscript after a letter alone", () => {
    expect(normalizeNumericIndices("m² a x³")).toBe("m² a x³");
  });
});
