import { describe, expect, test } from "bun:test";

import { railCourtAbbreviation } from "@/features/case-law/components/case-decision-rail-icon.logic";

describe("railCourtAbbreviation", () => {
  test("draws the abbreviations the tile was sized for", () => {
    // The corpus's own short forms, diacritics and the longest one included.
    for (const abbreviation of ["ÚS", "NS", "NSS", "SN", "CJEU"]) {
      expect(railCourtAbbreviation(abbreviation)).toBe(abbreviation);
    }
  });

  test("falls back where the court's short form is a word", () => {
    // Written out in Hungarian prose rather than abbreviated, so it overflows
    // a tile sized for capitals.
    expect(railCourtAbbreviation("Kúria")).toBeNull();
  });

  test("falls back where the corpus states no abbreviation", () => {
    for (const value of [null, undefined, "", "   "]) {
      expect(railCourtAbbreviation(value)).toBeNull();
    }
  });
});
