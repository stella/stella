import { describe, expect, test } from "bun:test";

import {
  citationTextMatches,
  normalizeForCitationMatch,
} from "@/api/lib/workflow/citation-normalize";

// Invisible or easily-confused code points are written as escapes so the
// test stays reviewable and deterministic (an editor cannot silently eat
// a literal zero-width space).
const NBSP = " ";
const NNBSP = " "; // narrow no-break space
const EN_QUAD = " ";
const HAIR_SPACE = " ";
const MMSP = " "; // medium mathematical space
const IDEOGRAPHIC_SPACE = "　";
const NB_HYPHEN = "‑";
const FIGURE_DASH = "‒";
const EN_DASH = "–";
const EM_DASH = "—";
const MINUS = "−";
const ZWSP = "​";
const ZWNJ = "‌";
const ZWJ = "‍";
const WORD_JOINER = "⁠";
const BOM = "﻿";
const COMBINING_ACUTE = "́";
const LEFT_DQUOTE = "“";
const RIGHT_DQUOTE = "”";
const RIGHT_SQUOTE = "’";
const PRIME = "′";
const DOUBLE_PRIME = "″";

const normalizeEqual = (a: string, b: string): boolean =>
  normalizeForCitationMatch(a, { caseFold: false }) ===
  normalizeForCitationMatch(b, { caseFold: false });

describe("normalizeForCitationMatch — whitespace class", () => {
  const spaces: [string, string][] = [
    ["regular space", " "],
    ["non-breaking space", NBSP],
    ["narrow no-break space", NNBSP],
    ["en quad", EN_QUAD],
    ["hair space", HAIR_SPACE],
    ["medium math space", MMSP],
    ["ideographic space", IDEOGRAPHIC_SPACE],
    ["tab", "\t"],
    ["newline", "\n"],
  ];

  for (const [name, sep] of spaces) {
    test(`${name} compares equal to a plain space`, () => {
      expect(normalizeEqual(`Section${sep}12`, "Section 12")).toBe(true);
    });
  }

  test("collapses runs of mixed whitespace and trims the ends", () => {
    expect(normalizeEqual("  Article  \t 4 \n", "Article 4")).toBe(true);
  });
});

describe("normalizeForCitationMatch — hyphen/dash class", () => {
  const dashes: [string, string][] = [
    ["hyphen-minus", "-"],
    ["non-breaking hyphen", NB_HYPHEN],
    ["figure dash", FIGURE_DASH],
    ["en dash", EN_DASH],
    ["em dash", EM_DASH],
    ["minus sign", MINUS],
  ];

  for (const [name, dash] of dashes) {
    test(`${name} folds to a common dash`, () => {
      expect(normalizeEqual(`co${dash}operate`, "co-operate")).toBe(true);
    });
  }
});

describe("normalizeForCitationMatch — quote/apostrophe class", () => {
  test("curly and straight double quotes compare equal", () => {
    expect(
      normalizeEqual(
        `${LEFT_DQUOTE}Force Majeure${RIGHT_DQUOTE}`,
        '"Force Majeure"',
      ),
    ).toBe(true);
  });

  test("curly and straight apostrophes compare equal", () => {
    expect(
      normalizeEqual(`the party${RIGHT_SQUOTE}s duty`, "the party's duty"),
    ).toBe(true);
  });

  test("primes fold to straight quotes", () => {
    expect(normalizeEqual(`5${PRIME} margin`, "5' margin")).toBe(true);
    expect(normalizeEqual(`5${DOUBLE_PRIME} margin`, '5" margin')).toBe(true);
  });
});

describe("normalizeForCitationMatch — Unicode form (NFC/NFD)", () => {
  test("composed and decomposed accented characters compare equal", () => {
    const composed = "résumé"; // é as U+00E9
    const decomposed = `re${COMBINING_ACUTE}sume${COMBINING_ACUTE}`; // e + U+0301
    expect(composed).not.toBe(decomposed);
    expect(normalizeEqual(composed, decomposed)).toBe(true);
  });

  test("folds to a canonical accent rather than stripping it to ASCII", () => {
    const decomposed = `Z${COMBINING_ACUTE}urich`;
    const normalized = normalizeForCitationMatch(decomposed, {
      caseFold: false,
    });
    expect(normalized).toBe("Źurich".normalize("NFC"));
    // The accent survives — it is not flattened away.
    expect(normalized).not.toBe("Zurich");
  });
});

describe("normalizeForCitationMatch — zero-width class", () => {
  const zeroWidth: [string, string][] = [
    ["zero-width space", ZWSP],
    ["zero-width non-joiner", ZWNJ],
    ["zero-width joiner", ZWJ],
    ["word joiner", WORD_JOINER],
    ["BOM", BOM],
  ];

  for (const [name, zw] of zeroWidth) {
    test(`${name} is stripped without inserting a boundary`, () => {
      expect(normalizeEqual(`Ver${zw}trag`, "Vertrag")).toBe(true);
    });
  }
});

describe("normalizeForCitationMatch — case folding", () => {
  test("case-insensitive by default", () => {
    expect(
      normalizeForCitationMatch("The PARTY") ===
        normalizeForCitationMatch("the party"),
    ).toBe(true);
  });

  test("case-sensitive when disabled", () => {
    expect(
      normalizeForCitationMatch("The PARTY", { caseFold: false }) ===
        normalizeForCitationMatch("the party", { caseFold: false }),
    ).toBe(false);
  });
});

describe("citationTextMatches — grounding decision", () => {
  const source =
    "The Seller shall indemnify the Buyer against all losses arising from a breach of this Agreement.";

  test("a verbatim span of the block verifies", () => {
    expect(citationTextMatches({ quote: "indemnify the Buyer", source })).toBe(
      true,
    );
  });

  test("an exact block match verifies", () => {
    expect(citationTextMatches({ quote: source, source })).toBe(true);
  });

  test("text absent from the block does not verify", () => {
    expect(
      citationTextMatches({ quote: "terminate for convenience", source }),
    ).toBe(false);
  });

  test("empty quote never verifies", () => {
    expect(citationTextMatches({ quote: "   ", source })).toBe(false);
  });

  // The regression the feature exists to prevent: a genuine legal quote
  // that differs from the stored block only by an NBSP, a curly
  // apostrophe, a dash variant, and a decomposed accent must still verify.
  test("real quote differing only by NBSP/curly-quote/dash/NFC still verifies", () => {
    const block = `Le vendeur s${RIGHT_SQUOTE}engage à indemniser l${RIGHT_SQUOTE}acheteur${NBSP}${EM_DASH} sans délai${NBSP}${EM_DASH} de toute perte.`;
    const quote = `s'engage à indemniser l'acheteur - sans de${COMBINING_ACUTE}lai - de toute perte`;
    expect(citationTextMatches({ quote, source: block })).toBe(true);
  });
});
