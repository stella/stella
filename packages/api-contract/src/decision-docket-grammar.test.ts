import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import {
  canonicalDecisionDocket,
  canonicalDecisionIdentifierKey,
  DECISION_DOCKET_GRAMMARS,
  decisionDocketGrammarForJurisdiction,
  foldDecisionIdentifierInput,
  formatDecisionDocket,
  parseDecisionDocket,
  storedDecisionDocketOf,
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
  EU: fc.oneof(
    fc
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
    // Numbered before 1989, without a court letter.
    fc
      .tuple(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 0, max: 99 }))
      .map(
        ([ordinal, year]) => `${ordinal}/${year.toString().padStart(2, "0")}`,
      ),
  ),
  GBR: fc
    .tuple(
      fc.integer({ min: 1600, max: 2099 }),
      fc.constantFrom(
        "UKSC",
        "UKPC",
        "UKHL",
        "EWCA Civ",
        "EWCA Crim",
        "EWHC",
        "UKUT",
        "UKFTT",
        "EAT",
        "EWFC",
        "EWCOP",
      ),
      fc.integer({ min: 1, max: 999_999 }),
    )
    .map(([year, court, number]) => `[${year}] ${court} ${number}`),
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
  USA: fc
    .tuple(
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 1, max: 9999 }),
      fc.constantFrom("-", "A", "O"),
      fc.boolean(),
    )
    .map(
      ([term, number, separator, labelled]) =>
        `${labelled ? "No. " : ""}${term.toString().padStart(2, "0")}${separator}${number}`,
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

  test("a United States docket keeps every digit of its number", () => {
    const canonicalOf = (docket: string) => {
      const parsed = DECISION_DOCKET_GRAMMARS.USA.parse(docket);
      expect(parsed, docket).not.toBeNull();
      return parsed === null ? null : canonicalDecisionDocket(parsed);
    };
    expect(canonicalOf("21-123")).toBe("21-123");
    expect(canonicalOf("21-123")).not.toBe(canonicalOf("21-456"));
    expect(canonicalOf("20A87")).not.toBe(canonicalOf("20A870"));
    expect(canonicalOf("No. 8, Orig.")).not.toBe(canonicalOf("No. 8"));
    // An original case's electronic and printed forms are one docket.
    expect(canonicalOf("22O141")).toBe(canonicalOf("No. 141, Orig."));
    expect(canonicalOf("22O141")).not.toBe(canonicalOf("22O142"));
    // The generic key other identifiers compare under is unchanged: it still
    // reads a trailing number as a sheet.
    expect(canonicalDecisionIdentifierKey("21-123")).toBe("21");
  });

  test("a United States docket is read only under its own scope", () => {
    for (const {
      canonical,
      variants,
    } of DECISION_DOCKET_GRAMMAR_FIXTURES.USA) {
      for (const docket of [canonical, ...variants]) {
        expect([docket, parseDecisionDocket(docket)]).toEqual([docket, null]);
        expect(
          parseDecisionDocket(docket, { grammar: DECISION_DOCKET_GRAMMARS.USA })
            ?.jurisdiction,
        ).toBe("USA");
      }
    }
    for (const text of ["10-12", "No. 5", "20A87", "No. 8, Orig."]) {
      expect([text, parseDecisionDocket(text)]).toEqual([text, null]);
    }
    expect(decisionDocketGrammarForJurisdiction("usa")).toBe(
      DECISION_DOCKET_GRAMMARS.USA,
    );
  });

  test("a Court of Justice case numbered before 1989 is read only under the EU scope", () => {
    // The Court numbered its cases without a letter until the Court of First
    // Instance was set up, and a stored row keeps the docket as printed.
    const scoped = (docket: string) =>
      parseDecisionDocket(docket, { grammar: DECISION_DOCKET_GRAMMARS.EU });
    for (const [docket, formatted] of [
      ["120/78", "120/78"],
      ["8/55", "8/55"],
      ["Case 302/87", "302/87"],
      ["věc 6/64", "6/64"],
    ] as const) {
      const parsed = scoped(docket);
      expect([docket, parsed?.formatted]).toEqual([docket, formatted]);
      expect(storedDecisionDocketOf(formatted, "EU")).toEqual({
        type: "canonical",
        caseNumber: formatted,
      });
    }
    // The letter names another case: `C-120/78` never keys as `120/78`.
    expect(scoped("120/78")?.canonical).not.toBe(scoped("C-120/78")?.canonical);
    // Bare, any number over a two-digit year: never claimed unscoped.
    for (const text of ["120/78", "Case 302/87", "1/20"]) {
      expect(parseDecisionDocket(text)?.jurisdiction, text).not.toBe("EU");
    }
    for (const text of ["120/1978", "120/7", "C120/78", "120/78 P", "/78"]) {
      expect(scoped(text), text).toBeNull();
    }
  });

  test("a bare number or prose is not a United States docket", () => {
    for (const text of [
      "1",
      "2079",
      "123-45",
      "1-2",
      "2021-123",
      "21 123",
      "A87",
      "Orig.",
      "No.",
      "the 21-123 case",
    ]) {
      expect(DECISION_DOCKET_GRAMMARS.USA.parse(text), text).toBeNull();
    }
  });

  test("no other jurisdiction's docket reads as a United States one", () => {
    // Unscoped parsing takes the first grammar that accepts, so a new grammar
    // must not reach a docket another jurisdiction already reads.
    for (const [jurisdiction, fixtures] of Object.entries(
      DECISION_DOCKET_GRAMMAR_FIXTURES,
    )) {
      if (jurisdiction === "USA") {
        continue;
      }
      for (const { canonical, variants } of fixtures) {
        for (const docket of [canonical, ...variants]) {
          const claimed = parseDecisionDocket(docket)?.jurisdiction;
          expect([docket, claimed !== undefined && claimed !== "USA"]).toEqual([
            docket,
            true,
          ]);
          expect([docket, DECISION_DOCKET_GRAMMARS.USA.parse(docket)]).toEqual([
            docket,
            null,
          ]);
        }
      }
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

describe("British neutral citations", () => {
  test("court-specific divisions reject malformed and foreign citations", () => {
    for (const raw of [
      "2024 UKSC 12",
      "[24] UKSC 12",
      "[2024] UKSC 0",
      "[2024] UKSC -12",
      "[2024] UKSC 12 (KB)",
      "[2024] EWCA 12",
      "[2024] EWCA Admin 12",
      "[2024] EWHC 123 (IAC)",
      "[2024] EWHC 123 (Unknown)",
      "[2024] EWHC 123 KB",
      "[2024] EWHC 123 (KB) extra",
      "[2024] CSIH 12",
      "[2024] NICA 12",
      "[2024] UKSC 12/13",
    ]) {
      expect(DECISION_DOCKET_GRAMMARS.GBR.parse(raw), raw).toBeNull();
    }
  });

  test("EWHC division metadata remains formatted but leaves the identity key", () => {
    const citations = DECISION_DOCKET_GRAMMAR_FIXTURES.GBR.filter(
      ({ canonical }) => canonical === "[2024] EWHC 123",
    ).flatMap(({ variants }) => variants);
    expect(citations.length).toBe(14);
    for (const citation of citations) {
      expect(DECISION_DOCKET_GRAMMARS.GBR.parse(citation)).toEqual({
        jurisdiction: "GBR",
        formatted: citation,
        canonical: "[2024]ewhc123",
        filingYear: { type: "none-in-format" },
      });
    }
  });
});

describe("Slovak courthouse workplace dockets", () => {
  test("svk.workplace-prefix-preserves-identity", () => {
    assertProperty(
      "svk.workplace-prefix-preserves-identity",
      fc.property(
        fc.constantFrom("B", "K", "M", "Z"),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 1, max: 999 }),
        fc.constantFrom("C", "Cb", "P", "T", "Obo"),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 1900, max: 2099 }),
        (letter, workplace, senate, registry, ordinal, year) => {
          const base = `${senate}${registry}/${ordinal}/${year}`;
          const docket = `${letter}${workplace}-${base}`;
          const parsed = DECISION_DOCKET_GRAMMARS.SVK.parse(docket);
          const spaced = DECISION_DOCKET_GRAMMARS.SVK.parse(
            `${letter}${workplace}‑${senate} ${registry} / ${ordinal}/${year}`,
          );
          expect(parsed).toEqual({
            jurisdiction: "SVK",
            formatted: docket,
            canonical: docket.toLowerCase(),
            filingYear: { type: "known", year },
          });
          expect(spaced).toEqual(parsed);
          expect(parsed?.canonical).not.toBe(
            DECISION_DOCKET_GRAMMARS.SVK.parse(base)?.canonical,
          );
        },
      ),
      { numRuns: 200, seed: 68_470_001 },
    );
  });

  test.each([
    ["B1-7C/221/1991", 1991],
    ["B4-14Cb/13/2021", 2021],
    ["K2-17P/72/2022", 2022],
  ] as const)(
    "a publisher workplace prefix remains part of %s",
    (docket, year) => {
      const parsed = DECISION_DOCKET_GRAMMARS.SVK.parse(docket);
      expect(parsed).toEqual({
        jurisdiction: "SVK",
        formatted: docket,
        canonical: docket.toLowerCase(),
        filingYear: { type: "known", year },
      });
      expect(storedDecisionDocketOf(docket, "SVK")).toEqual({
        type: "canonical",
        caseNumber: docket,
      });
      const unprefixed = DECISION_DOCKET_GRAMMARS.SVK.parse(
        docket.slice(docket.indexOf("-") + 1),
      );
      expect(unprefixed).not.toBeNull();
      expect(parsed?.canonical).not.toBe(unprefixed?.canonical);
    },
  );
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
        filingYear: grammar.filingYear(typed),
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

describe("stored dockets", () => {
  const JUNK_TAILS = [
    "- II.",
    "-III.",
    " - IV",
    ".",
    " -",
    "- ",
    " (I.)",
    " - XXIV.",
  ] as const;

  for (const grammar of Object.values(DECISION_DOCKET_GRAMMARS)) {
    test(`${grammar.jurisdiction} docket with a trailing part marker trims to the docket`, () => {
      fc.assert(
        fc.property(
          canonicalDocketArbitraries[grammar.jurisdiction],
          fc.constantFrom(...JUNK_TAILS),
          (docket, tail) => {
            expect(
              storedDecisionDocketOf(docket, grammar.jurisdiction),
            ).toEqual({ type: "canonical", caseNumber: docket });
            const stored = storedDecisionDocketOf(
              `${docket}${tail}`,
              grammar.jurisdiction,
            );
            if (stored.type === "canonical") {
              // The grammar itself accepts the tail (a closing dot).
              return;
            }
            expect(stored.type).toBe("trimmed");
            if (stored.type === "trimmed") {
              // The shortest accepted cut: the docket itself, or more of the
              // tail where a looser form of the grammar accepts that too.
              expect(grammar.parse(stored.caseNumber)).not.toBeNull();
              expect(
                stored.caseNumber.startsWith(
                  foldDecisionIdentifierInput(docket),
                ),
              ).toBe(true);
            }
          },
        ),
        propertyConfig(),
      );
    });
  }

  test.each([
    ["CZE", "33 Cdo 1751/2023- II.", "33 Cdo 1751/2023"],
    ["CZE", "Pl. ÚS 5/01 - IV.", "Pl. ÚS 5/01"],
    ["SVK", "5Obo/12/2020 - II.", "5Obo/12/2020"],
    ["SVK", "II. ÚS 55/98-I", "II. ÚS 55/98"],
    ["POL", "I ACa 123/20 - II", "I ACa 123/20"],
    ["POL", "II FSK 1226/21.", "II FSK 1226/21"],
    ["HUN", "Kfv.35.123/2021/8 - I.", "Kfv.35.123/2021/8"],
    ["EU", "C-1/20 - II.", "C-1/20"],
  ])("%s %s trims to %s", (jurisdiction, raw, caseNumber) => {
    const stored = storedDecisionDocketOf(raw, jurisdiction);
    expect(stored.type).toBe("trimmed");
    expect(stored.type === "trimmed" ? stored.caseNumber : null).toBe(
      caseNumber,
    );
  });

  test.each([
    // A sheet number and a closing dot the grammar declares stay.
    ["CZE", "21 Cdo 1234/2020-5"],
    ["HUN", "5.P.21.203/2004."],
  ])("%s %s is kept as written", (jurisdiction, raw) => {
    expect(storedDecisionDocketOf(raw, jurisdiction)).toEqual({
      type: "canonical",
      caseNumber: raw,
    });
  });

  test.each([
    // A word, a numeral that is not a part number, or a digit is never cut.
    ["CZE", "33 Cdo 1751/2023 civil"],
    ["CZE", "33 Cdo 1751/2023-XL"],
    ["POL", "I ACa 123/20 - wyrok"],
    ["SVK", "NALUS record 7301"],
  ])("%s %s is unparsed, not trimmed", (jurisdiction, raw) => {
    expect(storedDecisionDocketOf(raw, jurisdiction)).toEqual({
      type: "unparsed",
    });
  });

  test("a jurisdiction without a grammar is ungoverned", () => {
    expect(storedDecisionDocketOf("1 A 2/2020 - II.", "XXX")).toEqual({
      type: "ungoverned",
    });
  });

  test("the trimmed docket is folded the way the grammar reads it", () => {
    const stored = storedDecisionDocketOf(
      "33\u00a0Cdo 1751/2023\u2011 II.",
      "CZE",
    );
    expect(stored).toEqual({
      type: "trimmed",
      caseNumber: foldDecisionIdentifierInput("33 Cdo 1751/2023"),
      removed: "- II.",
    });
  });
});
