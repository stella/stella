import { describe, expect, test } from "bun:test";

import { ASCII_FOLD_TABLE } from "./ascii-fold-table.js";
import { foldToAscii } from "./ascii-fold.js";
import { stripDiacritics } from "./diacritics.js";

/**
 * Pinned from the extension that owns the contract:
 *
 * ```sql
 * SELECT w, unaccent(w) FROM (VALUES ('łaska'), ...) AS t(w);
 * ```
 *
 * Czech and Slovak words fold through NFD alone; the Polish ones are the
 * regression, because `ł` has no canonical decomposition.
 */
const UNACCENT_GOLDEN: readonly (readonly [string, string])[] = [
  ["łaska", "laska"],
  ["Świętochłowice", "Swietochlowice"],
  ["Łódź", "Lodz"],
  ["zażółć gęślą jaźń", "zazolc gesla jazn"],
  ["wyłączenie sędziego", "wylaczenie sedziego"],
  ["příliš žluťoučký kůň", "prilis zlutoucky kun"],
  ["odôvodnenie", "odovodnenie"],
  ["Nejvyšší správní soud", "Nejvyssi spravni soud"],
  ["rozsudek Sądu Najwyższego", "rozsudek Sadu Najwyzszego"],
  ["Đukanović", "Dukanovic"],
  ["Straße", "Strasse"],
  ["København", "Kobenhavn"],
  ["œuvre", "oeuvre"],
  ["Æthelred", "AEthelred"],
  ["İstanbul", "Istanbul"],
  ["ıspanak", "ispanak"],
];

const ASCII_ONLY_RE = /^\p{ASCII}*$/u;

// Iterated per code point, because the table is keyed by code points and one
// of its keys (U+107A5) lives outside the basic multilingual plane.
const decomposesToDeclaredChar = (char: string): boolean => {
  for (const unit of char.normalize("NFD")) {
    if (unit in ASCII_FOLD_TABLE) {
      return true;
    }
  }
  return false;
};

describe("foldToAscii", () => {
  test.each(UNACCENT_GOLDEN)("fold(%p) === %p", (input, expected) => {
    expect(foldToAscii(input)).toBe(expected);
  });

  test("collapses the ł/l pair the index stores as one lexeme", () => {
    // `to_tsvector('public.stella_unaccent', 'łaska laska')` produces the
    // single lexeme 'laska':1,2. A query-side fold that leaves `ł` standing
    // asks the index for a lexeme it never stored.
    expect(foldToAscii("łaska")).toBe(foldToAscii("laska"));
    expect(foldToAscii("Łaska")).toBe("Laska");
  });

  test("reproduces every declared rule", () => {
    for (const [char, folded] of Object.entries(ASCII_FOLD_TABLE)) {
      expect(foldToAscii(char)).toBe(folded);
    }
  });

  test("folds Latin text to ASCII", () => {
    for (const input of [
      ...Object.keys(ASCII_FOLD_TABLE),
      ...UNACCENT_GOLDEN.map(([word]) => word),
    ]) {
      expect(foldToAscii(input)).toMatch(ASCII_ONLY_RE);
    }
  });

  test("is idempotent", () => {
    for (const input of [
      ...Object.keys(ASCII_FOLD_TABLE),
      ...UNACCENT_GOLDEN.map(([word]) => word),
    ]) {
      const once = foldToAscii(input);
      expect(foldToAscii(once)).toBe(once);
    }
  });

  test("diverges from stripDiacritics only on declared rules", () => {
    // The fold is NFD + mark strip plus the table, so a code point may only
    // diverge when the strip leaves a declared character standing (`Ǽ`
    // decomposes to `Æ`, which the table then folds to `AE`). Everywhere else
    // the new fold must be the old one, not a second dialect.
    for (let codePoint = 1; codePoint <= 0x2_ff_ff; codePoint += 1) {
      if (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) {
        continue;
      }
      const char = String.fromCodePoint(codePoint);
      if (decomposesToDeclaredChar(char)) {
        continue;
      }
      expect(foldToAscii(char)).toBe(stripDiacritics(char));
    }
  });

  test("passes non-Latin scripts through with marks stripped", () => {
    // Out of contract: Greek, Cyrillic, and Arabic keep their letters, so the
    // fold stays safe to run ahead of the script-specific normalizers.
    expect(foldToAscii("Ελληνικά")).toBe("Ελληνικα");
    expect(foldToAscii("Йошкар-Ола")).toBe("Иошкар-Ола");
    expect(foldToAscii("قرار")).toBe("قرار");
  });
});
