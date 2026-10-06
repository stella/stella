import { describe, expect, test } from "bun:test";

import { stripDiacritics, stripDiacriticsForSlug } from "./diacritics.js";

// Czech, Slovak, and Polish legal text: the base letter must survive, the
// diacritic must go, so accent-insensitive search matches either spelling.
const LATIN_GOLDEN: readonly (readonly [string, string])[] = [
  ["černý žaloba", "cerny zaloba"],
  ["odôvodnenie", "odovodnenie"],
  ["příliš žluťoučký kůň", "prilis zlutoucky kun"],
  // ż/ó/ć/ę/ś/ź lose their marks; ł (U+0142) is an atomic stroke letter
  // with no combining mark, so it is not a diacritic and survives.
  ["zażółć gęślą jaźń", "zazołc gesla jazn"],
  ["Ñandú", "Nandu"],
];

describe("stripDiacritics (NFD)", () => {
  test.each(LATIN_GOLDEN)("strip(%p) === %p", (input, expected) => {
    expect(stripDiacritics(input)).toBe(expected);
  });

  test("strips combining marks outside U+0300–U+036F", () => {
    // U+1AB0 (Combining Diacritical Marks Extended) and U+1DC4
    // (Supplement) are Diacritic=Yes marks a [̀-ͯ] range would miss.
    expect(stripDiacritics("a᪰b᷄c")).toBe("abc");
  });

  test("leaves precomposed compatibility characters intact (NFD)", () => {
    // NFD does not decompose the ﬁ ligature or the superscript ².
    expect(stripDiacritics("ﬁ²")).toBe("ﬁ²");
  });

  test("is idempotent", () => {
    for (const [input] of LATIN_GOLDEN) {
      const once = stripDiacritics(input);
      expect(stripDiacritics(once)).toBe(once);
    }
  });
});

describe("stripDiacriticsForSlug (NFKD)", () => {
  test.each(LATIN_GOLDEN)("slug-strip(%p) === %p", (input, expected) => {
    expect(stripDiacriticsForSlug(input)).toBe(expected);
  });

  test("decomposes compatibility characters so slugs fold to ASCII", () => {
    // The NFKD form is what the persisted case-law/law-material slugs were
    // generated with; these must keep folding to their ASCII base.
    expect(stripDiacriticsForSlug("ﬁ")).toBe("fi");
    expect(stripDiacriticsForSlug("²")).toBe("2");
    expect(stripDiacriticsForSlug("Ⅳ")).toBe("Ⅳ".normalize("NFKD"));
  });

  test("diverges from NFD only on compatibility characters", () => {
    // Plain accented Latin folds identically in both forms; the variants
    // exist purely for the compatibility-decomposition cases above.
    for (const [input, expected] of LATIN_GOLDEN) {
      expect(stripDiacriticsForSlug(input)).toBe(expected);
      expect(stripDiacriticsForSlug(input)).toBe(stripDiacritics(input));
    }
  });
});
