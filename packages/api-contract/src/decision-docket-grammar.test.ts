import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  canonicalDecisionDocket,
  DECISION_DOCKET_GRAMMARS,
  decisionDocketGrammarForJurisdiction,
  formatDecisionDocket,
  parseDecisionDocket,
} from "./decision-docket-grammar";
import type { DecisionDocketJurisdiction } from "./decision-docket-grammar";
import { DECISION_DOCKET_GRAMMAR_FIXTURES } from "./decision-docket-grammar.fixtures";

const canonicalDocketArbitraries = {
  AUT: fc.oneof(
    fc
      .tuple(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1, max: 99_999 }),
        fc.integer({ min: 0, max: 99 }),
      )
      .map(
        ([senate, ordinal, year]) =>
          `${senate} Xy ${ordinal}/${year.toString().padStart(2, "0")}x`,
      ),
    fc
      .tuple(
        fc.integer({ min: 1900, max: 2099 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 9999 }),
      )
      .map(
        ([year, registry, ordinal]) =>
          `Ra ${year}/${registry.toString().padStart(2, "0")}/${ordinal
            .toString()
            .padStart(4, "0")}`,
      ),
  ),
  CZE: fc.oneof(
    fc
      .tuple(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 1900, max: 2099 }),
      )
      .map(([senate, ordinal, year]) => `${senate} Xyz ${ordinal}/${year}`),
    fc
      .tuple(
        fc.constantFrom("I", "II", "III", "IV"),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 0, max: 99 }),
      )
      .map(
        ([chamber, ordinal, year]) =>
          `${chamber}. XÝ ${ordinal}/${year.toString().padStart(2, "0")}`,
      ),
  ),
  EU: fc
    .tuple(
      fc.constantFrom("C", "T", "F"),
      fc.integer({ min: 1, max: 9999 }),
      fc.integer({ min: 0, max: 99 }),
      fc.boolean(),
    )
    .map(
      ([court, ordinal, year, appeal]) =>
        `${court}-${ordinal}/${year.toString().padStart(2, "0")}${
          appeal ? " P" : ""
        }`,
    ),
  HUN: fc.oneof(
    fc
      .tuple(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 1900, max: 2099 }),
        fc.integer({ min: 1, max: 9999 }),
      )
      .map(
        ([thousands, rest, year, document]) =>
          `Xyz.IV.${thousands}.${rest.toString().padStart(3, "0")}/${year}/${document}`,
      ),
    fc
      .tuple(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 1900, max: 2099 }),
      )
      .map(([panel, register, year]) => `${panel}.Xy.${register}/${year}.`),
  ),
  POL: fc.oneof(
    fc
      .tuple(
        fc.constantFrom("I", "II", "III", "IV", "V"),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 0, max: 99 }),
      )
      .map(
        ([chamber, ordinal, year]) =>
          `${chamber} XYZ ${ordinal}/${year.toString().padStart(2, "0")}`,
      ),
    fc
      .tuple(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 99_999 }),
        fc.integer({ min: 2017, max: 2099 }),
        fc.integer({ min: 1, max: 99 }),
      )
      .map(
        ([office, ordinal, year, sheet]) =>
          `${office.toString().padStart(4, "0")}-XYZ9-9.9999.${ordinal}.${year}.${sheet}.XY`,
      ),
    fc
      .tuple(
        fc.constantFrom("XYZ", "XYZW", "ŁXY", "XYZ-II", "XYZ-9"),
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1990, max: 2099 }),
      )
      .map(([unit, ordinal, year]) => `${unit}-${ordinal}/${year}`),
  ),
  SVK: fc.oneof(
    fc
      .tuple(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 1900, max: 2099 }),
      )
      .map(([senate, ordinal, year]) => `${senate}Xyz/${ordinal}/${year}`),
    fc
      .tuple(
        fc.constantFrom("I", "II", "III", "IV", "PL"),
        fc.integer({ min: 1, max: 99_999 }),
        fc.oneof(
          fc
            .integer({ min: 0, max: 99 })
            .map((year) => `${year}`.padStart(2, "0")),
          fc.integer({ min: 1993, max: 2099 }).map((year) => `${year}`),
        ),
      )
      .map(([senate, ordinal, year]) => `${senate}. ÚS ${ordinal}/${year}`),
  ),
} as const satisfies Record<DecisionDocketJurisdiction, Arbitrary<string>>;

describe("declared decision docket grammars", () => {
  test("scope lookup is case-insensitive and unknown scopes stay absent", () => {
    expect(decisionDocketGrammarForJurisdiction("pol")).toBe(
      DECISION_DOCKET_GRAMMARS.POL,
    );
    expect(decisionDocketGrammarForJurisdiction("unknown")).toBeNull();
  });

  test("a Czech registry mark standing alone is a court docket, an acronym is not", () => {
    for (const docket of ["Nad 224/2014", "Konf 4/2011", "A 9/2003"]) {
      expect(DECISION_DOCKET_GRAMMARS.CZE.parse(docket)).not.toBeNull();
    }
    // Ministries label their file numbers with the same `č. j.` as a court
    // labels a docket, so only the all-caps acronym separates the two.
    for (const fileNumber of ["MZDR 6206/2025", "MFCR 12/2024"]) {
      expect(DECISION_DOCKET_GRAMMARS.CZE.parse(fileNumber)).toBeNull();
      expect(parseDecisionDocket(fileNumber)).toBeNull();
    }
  });

  test("a tax signature and a court docket never claim each other", () => {
    const signatures = [
      "0114-KDIP1-2.4012.123.2024.1.AB",
      "0112-KDIL3.4012.367.2026.2.AK",
      "0110-KSI2-2.441.43.2025.2.BŁ",
      "1401-ICW.421.21.2023.13.WCH",
      "DD4.8201.2.2026",
      "DOP3.8222.23.2026.EILK",
      "PT1.050.1.2015.LJU.19",
      "IPPB3/423-1234/08-2/JG",
      "IBPBI/2/423-123/08/SD",
      "IP-PB3-423-655/08-3/MB",
      "ITPB1/423-39/a/07/AW",
      "PP10-812-802/04/MR/1556PP",
      "0114-KDIP3-1.4011.419.2018.1.KS1",
      "0114-KDIP2-1.4011.257.2021.2.KW/PD",
      "PT8.8101.47.2015/WCH/179",
    ];
    for (const signature of signatures) {
      const parsed = DECISION_DOCKET_GRAMMARS.POL.parse(signature);
      expect(parsed, signature).not.toBeNull();
      // Every trailing number names a document of its own, unlike a court's
      // sheet number, so none of it is folded away.
      expect(parsed?.canonical).toBe(signature.toLocaleLowerCase("und"));
    }
    for (const docket of [
      "II FSK 1234/19",
      "III SA/Wa 1234/19",
      "I SA/Gd 123/20",
    ]) {
      const parsed = DECISION_DOCKET_GRAMMARS.POL.parse(docket);
      expect(parsed, docket).not.toBeNull();
      expect(parsed?.canonical).not.toContain(".");
    }
    for (const fragment of [
      "0114-KDIP1",
      "DD4.8201",
      "4012.123.2024.1",
      "0114-KDIP1-2.4012.123.2024",
      "IPPB3/423",
      "0114 KDIP1 2.4012.123.2024.1.AB",
    ]) {
      expect(parseDecisionDocket(fragment), fragment).toBeNull();
    }
    // An Austrian fiscal court's docket shares the slashes, not the shape.
    expect(DECISION_DOCKET_GRAMMARS.POL.parse("RV/2100968/2026")).toBeNull();
  });

  test("every dash spelling of a sheet separator folds to one docket", () => {
    const canonical = DECISION_DOCKET_GRAMMARS.CZE.parse("8 As 287/2020-33");
    expect(canonical).not.toBeNull();
    for (const dash of ["‐", "‑", "‒", "–", "−"]) {
      expect(
        DECISION_DOCKET_GRAMMARS.CZE.parse(`8 As 287/2020${dash}33`),
      ).toEqual(canonical);
    }
  });

  for (const grammar of Object.values(DECISION_DOCKET_GRAMMARS)) {
    test(`${grammar.jurisdiction} format is a parse fixed point`, () => {
      fc.assert(
        fc.property(
          canonicalDocketArbitraries[grammar.jurisdiction],
          (canonical) => {
            const parsed = grammar.parse(canonical);
            expect(parsed).not.toBeNull();
            if (parsed === null) {
              return;
            }
            expect(grammar.parse(formatDecisionDocket(parsed))).toEqual(parsed);
          },
        ),
        propertyConfig(),
      );
    });

    test(`${grammar.jurisdiction} fixtures keep distinct dockets apart`, () => {
      const canonicalKeys = DECISION_DOCKET_GRAMMAR_FIXTURES[
        grammar.jurisdiction
      ].map(({ canonical }) => {
        const parsed = grammar.parse(canonical);
        expect(parsed).not.toBeNull();
        return parsed === null ? canonical : canonicalDecisionDocket(parsed);
      });
      expect(new Set(canonicalKeys).size).toBe(canonicalKeys.length);
    });

    test(`${grammar.jurisdiction} variants share one canonical value`, () => {
      const fixtures = DECISION_DOCKET_GRAMMAR_FIXTURES[grammar.jurisdiction];
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const base = grammar.parse(fixture.canonical);
        expect(base).not.toBeNull();
        if (base === null) {
          continue;
        }
        for (const variant of fixture.variants) {
          const parsed = grammar.parse(variant);
          expect(parsed).not.toBeNull();
          if (parsed !== null) {
            expect(canonicalDecisionDocket(parsed)).toBe(
              canonicalDecisionDocket(base),
            );
          }
        }
      }
    });
  }
});

describe("Slovak Constitutional Court dockets", () => {
  const grammar = DECISION_DOCKET_GRAMMARS.SVK;

  test("the spellings readers type reach the stored key", () => {
    const cases = [
      ["II. ÚS 55/98", "II. ÚS 55/98", "iiús55/98"],
      ["IV. US 221/04", "IV. ÚS 221/04", "ivús221/04"],
      ["II.ÚS 55/98", "II. ÚS 55/98", "iiús55/98"],
      ["I. ÚS 66/98", "I. ÚS 66/98", "iús66/98"],
      ["III. ÚS 682/2017", "III. ÚS 682/2017", "iiiús682/2017"],
      ["PL. ÚS 3/2019", "PL. ÚS 3/2019", "plús3/2019"],
      ["Pl. ÚS 3/2019", "PL. ÚS 3/2019", "plús3/2019"],
      ["i. ús 19/00", "I. ÚS 19/00", "iús19/00"],
    ] as const;
    for (const [typed, formatted, canonical] of cases) {
      expect(grammar.parse(typed), typed).toEqual({
        jurisdiction: "SVK",
        formatted,
        canonical,
      });
    }
  });

  test("a senate the court does not have, or a three-digit year, is not a docket", () => {
    for (const text of [
      "V. ÚS 1/20",
      "II. ÚS 55/998",
      "II. ÚSX 55/98",
      "ÚS 55/98",
      "plus 5/98",
    ]) {
      expect(grammar.parse(text), text).toBeNull();
    }
  });

  test("every accepted spelling of one docket normalizes to one key", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("I", "II", "III", "IV", "PL"),
        fc.integer({ min: 1, max: 99_999 }),
        fc.constantFrom("98", "04", "2017"),
        fc.tuple(
          fc.boolean(),
          fc.constantFrom(". ", ".", " ", ".  ", ". "),
          fc.constantFrom("ÚS", "US", "ús", "us", "Ús", "uS", "ÚS"),
          fc.constantFrom("", " ", "/", " / "),
          fc.constantFrom("", " ", "  ", " "),
        ),
        (senate, ordinal, year, [lower, separator, mark, tail, pad]) => {
          const reference = grammar.parse(`${senate}. ÚS ${ordinal}/${year}`);
          const typed = `${pad}${lower ? senate.toLowerCase() : senate}${separator}${mark}${tail}${ordinal}/${year}${pad}`;
          const parsed = grammar.parse(typed);
          expect(parsed, typed).toEqual(reference);
          expect(parsed?.canonical).toBe(
            `${senate.toLowerCase()}ús${ordinal}/${year}`,
          );
        },
      ),
      propertyConfig(),
    );
  });
});
