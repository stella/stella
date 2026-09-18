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
  ],
  SVK: [
    {
      canonical: "99Xyz/999999/2099",
      variants: ["99 xyz 999999/2099", "99 xyz / 999999/2099"],
    },
  ],
} as const satisfies Record<
  DecisionDocketJurisdiction,
  readonly DecisionDocketGrammarFixture[]
>;
