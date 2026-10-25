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
  GBR: [
    { canonical: "[2024] UKSC 12", variants: [" [2024] uksc 12 "] },
    { canonical: "[2023] UKPC 5", variants: ["[2023] ukpc 5"] },
    { canonical: "[2008] UKHL 9", variants: ["[2008] ukhl 9"] },
    { canonical: "[2025] EWCA Civ 1759", variants: ["[2025] ewca civ 1759"] },
    { canonical: "[2025] EWCA Crim 12", variants: ["[2025] ewca crim 12"] },
    {
      canonical: "[2024] EWHC 123",
      variants: [
        "[2024] EWHC 123 (KB)",
        "[2024] EWHC 123 (QB)",
        "[2024] EWHC 123 (Ch)",
        "[2024] EWHC 123 (Fam)",
        "[2024] EWHC 123 (Admin)",
        "[2024] EWHC 123 (Comm)",
        "[2024] EWHC 123 (TCC)",
        "[2024] EWHC 123 (Pat)",
        "[2024] EWHC 123 (IPEC)",
        "[2024] EWHC 123 (Admlty)",
        "[2024] EWHC 123 (SCCO)",
        "[2024] EWHC 123 (Costs)",
        "[2024] EWHC 123 (Mercantile)",
        "[2024] EWHC 123 (BP)",
      ],
    },
    { canonical: "[2024] EWHC 124 (KB)", variants: [] },
    { canonical: "[2023] EWHC 123 (KB)", variants: [] },
    { canonical: "[2024] UKUT 100 (IAC)", variants: ["[2024] ukut 100 (iac)"] },
    { canonical: "[2024] UKFTT 50 (TC)", variants: ["[2024] ukftt 50 (tc)"] },
    { canonical: "[2024] EAT 10", variants: ["[2024] eat 10"] },
    { canonical: "[2024] EWFC 12", variants: ["[2024] ewfc 12"] },
    { canonical: "[2024] EWCOP 12", variants: ["[2024] ewcop 12"] },
  ],
  HUN: [
    {
      canonical: "Pfv.21.123/2019/5.",
      variants: ["Pfv.21123/2019/5", "Pfv.21.123/2019/5"],
    },
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
        "IV.ÚS/999/99",
        "IV. ÚS 999/99-1",
        "IV.ÚS/999/99−12",
      ],
    },
    {
      canonical: "PL. ÚS 99/2099",
      variants: ["Pl. ÚS 99/2099", "pl us 99/2099", "PL.ÚS 99/2099"],
    },
    {
      canonical: "99Xyz/999999/2099",
      variants: [
        "99 xyz 999999/2099",
        "99 xyz / 999999/2099",
        "99Xyz/999999/2099‑42",
      ],
    },
  ],
  USA: [
    {
      canonical: "21-123",
      variants: ["No. 21-123", "no.21‑123", " 21–123 "],
    },
    // The same term one number apart is another case, not a sheet of it.
    {
      canonical: "21-456",
      variants: ["No. 21-456"],
    },
    {
      canonical: "19-1392",
      variants: ["No. 19-1392", "no 19−1392"],
    },
    {
      canonical: "20A87",
      variants: ["20a87", "No. 20A87"],
    },
    // An original case: its electronic and printed forms are one docket.
    {
      canonical: "22O141",
      variants: ["22o141", "No. 22O141", "No. 141, Orig.", "141, Orig."],
    },
    {
      canonical: "No. 8, Orig.",
      variants: ["8, Orig.", "No. 8 Orig", "no. 8, original"],
    },
    {
      canonical: "No. 1",
      variants: ["no. 1", "No 1", "No.1"],
    },
    {
      canonical: "No. 8",
      variants: ["no.8"],
    },
  ],
} as const satisfies Record<
  DecisionDocketJurisdiction,
  readonly DecisionDocketGrammarFixture[]
>;
