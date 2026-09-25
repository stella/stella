import type { DecisionDocketJurisdiction } from "./decision-docket-grammar";

type DecisionDocketGrammarFixture = {
  readonly canonical: string;
  readonly variants: readonly string[];
};

/** Synthetic spellings that each declared grammar must canonicalize alike. */
export const DECISION_DOCKET_GRAMMAR_FIXTURES = {
  AUT: [
    {
      canonical: "99 Xy 99999/99x",
      variants: ["99xy99999/99X", " 99 xy 99999/99x "],
    },
    {
      canonical: "Ra 2099/99/9999",
      variants: ["ra2099/99/9999"],
    },
    {
      canonical: "XY 9999/2099-999",
      variants: ["xy9999/2099-999"],
    },
    {
      canonical: "XYZ/99999999/2099",
      variants: ["xyz/99999999/2099"],
    },
  ],
  CZE: [
    {
      canonical: "99 Xyz 999999/2099",
      variants: ["99 xyz 999999/2099"],
    },
    {
      canonical: "IV. XÝ 999/99",
      variants: ["iv.xy 999/99-999", " IV. XÝ 999/99 ", "iv xy 999/99"],
    },
    {
      canonical: "Xyz 999999/2099",
      variants: ["Xyz 999999/2099-999", " Xyz 999999/2099 "],
    },
  ],
  EU: [
    {
      canonical: "C-9999/99 P",
      variants: ["case c‑9999/99 p", " C−9999/99 P "],
    },
  ],
  HUN: [
    {
      canonical: "Xyz.IV.99.999/2099/9",
      variants: [
        "xyz.iv.99999/2099/9",
        "XYZ.IV.99.999/2099/9",
        " Xyz.IV.99.999/2099/9 ",
      ],
    },
    {
      canonical: "Xy.99.999/2099/9",
      variants: ["xy.99999/2099/9"],
    },
    {
      canonical: "9.Xy.99.999/2099.",
      variants: ["9.xy.99999/2099.", "9.Xy.99.999/2099", " 9.XY.99.999/2099. "],
    },
    // A panel numeral against a registry mark ending in those same letters.
    {
      canonical: "Xy.I.9/2099",
      variants: ["xy.i.9/2099", " Xy.I.9/2099 "],
    },
    {
      canonical: "Xyi.9/2099",
      variants: ["xyi.9/2099", " Xyi.9/2099 "],
    },
  ],
  POL: [
    {
      canonical: "IV XYZ 999999/99",
      variants: ["iv xyz 999999/99"],
    },
    {
      canonical: "III AUa 999999/99",
      variants: ["iii a ua 999999/99", "III A/Ua 999999/99"],
    },
    {
      canonical: "9999-XYZW9-9.9999.999.2099.9.XY",
      variants: [
        "9999-xyzw9-9.9999.999.2099.9.xy",
        " 9999–XYZW9–9.9999.999.2099.9.XY ",
      ],
    },
    // The same numbers one sheet apart are two documents, not one.
    {
      canonical: "9999-XYZW9-9.9999.999.2099.8.XY",
      variants: ["9999-xyzw9-9.9999.999.2099.8.xy"],
    },
    {
      canonical: "XY9.9999.9.2099",
      variants: ["xy9.9999.9.2099"],
    },
    {
      canonical: "XYZW9/999-9999/99-9/XY",
      variants: ["xyzw9/999-9999/99-9/xy", "XYZW9/999‑9999/99‑9/XY"],
    },
    // A competition authority's decision number, spaced or not around its
    // hyphens, with and without a division between code and ordinal.
    {
      canonical: "XYZ-999/2099",
      variants: [" XYZ - 999/2099 ", "XYZ–999/2099"],
    },
    {
      canonical: "XYZ-II-99/2099",
      variants: ["XYZ - II - 99/2099"],
    },
    {
      canonical: "XYZ-9-99/2099",
      variants: ["XYZ‑9‑99/2099", "XYZ - 9 - 99/2099"],
    },
  ],
  SVK: [
    {
      canonical: "IV. ÚS 999/99",
      variants: [
        "IV. US 999/99",
        "iv.ús 999/99",
        "IV ÚS999/99",
        "IV.US 999/99",
      ],
    },
    {
      canonical: "PL. ÚS 99/2099",
      variants: ["Pl. ÚS 99/2099", "pl us 99/2099", "PL.ÚS 99/2099"],
    },
    {
      canonical: "99Xyz/999999/2099",
      variants: ["99 xyz 999999/2099", "99 xyz / 999999/2099"],
    },
  ],
} as const satisfies Record<
  DecisionDocketJurisdiction,
  readonly DecisionDocketGrammarFixture[]
>;
