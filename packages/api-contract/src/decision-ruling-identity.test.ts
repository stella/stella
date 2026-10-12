import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  DECISION_IDENTIFIER_TYPES,
  normalizeStructuredDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import { propertyConfig } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  foldRulingIdentity,
  rulingGroupKeys,
  rulingKeysOf,
  RULING_IDENTITY_VERSION,
} from "./decision-ruling-identity";

const decision = {
  country: "CZ",
  court: "Ústavní soud",
  decisionDate: "2007-04-03",
  caseNumber: "Pl. ÚS 38/06",
};
const unicodeString = fc
  .array(fc.integer({ min: 0, max: 0x10_ff_ff }), { maxLength: 80 })
  .map((points) => String.fromCodePoint(...points));
const docketOf = (caseNumber: string) =>
  rulingKeysOf({ ...decision, caseNumber }).dockets.at(0)?.key;
const gaps = fc.constantFrom(
  " ",
  "\u00a0",
  "\u200b",
  "\u200d",
  "\u2060",
  "\u202f",
);

describe("derived ruling identity", () => {
  test("retains stated values and uses the shared ECLI normalization", () => {
    const ecli = " ECLI:CZ:US:2007:Pl.US.38.06 ";
    expect(rulingKeysOf({ ...decision, ecli, decisionType: "NÁLEZ" })).toEqual({
      version: RULING_IDENTITY_VERSION,
      country: "cz",
      court: { kind: "name", stated: decision.court, key: "ustavnisoud" },
      date: { kind: "stated", value: decision.decisionDate },
      dockets: [{ stated: decision.caseNumber, key: "plus38/6" }],
      ecli: {
        kind: "stated",
        stated: ecli,
        key: normalizeStructuredDecisionIdentifier({
          type: DECISION_IDENTIFIER_TYPES.ECLI,
          value: ecli,
        }),
      },
      decisionKind: { kind: "stated", stated: "NÁLEZ", key: "nalez" },
      defects: [],
    });
  });

  test("directory identity takes precedence and cannot alias a name", () => {
    const keys = rulingKeysOf({ ...decision, courtId: "court-1" });
    expect(keys.court).toEqual({ kind: "directory", id: "court-1" });
    expect(rulingGroupKeys(keys)).toEqual(
      rulingGroupKeys(
        rulingKeysOf({ ...decision, court: "Other name", courtId: "court-1" }),
      ),
    );
    expect(rulingGroupKeys(keys)).not.toEqual(
      rulingGroupKeys(rulingKeysOf({ ...decision, court: "court-1" })),
    );
  });

  test("deduplicates docket keys and excludes other identifier kinds", () => {
    const keys = rulingKeysOf({
      ...decision,
      identifiers: [
        { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "PL ÚS 038/006" },
        { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "Pl ÚS 39/06" },
        { type: DECISION_IDENTIFIER_TYPES.ECLI, value: "ECLI:CZ:US:2007:38" },
        {
          type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
          value: "2007 ABC 1",
        },
        {
          type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          value: "2007 ABC 2",
        },
      ],
    });
    expect(keys.dockets).toEqual([
      { stated: decision.caseNumber, key: "plus38/6" },
      { stated: "Pl ÚS 39/06", key: "plus39/6" },
    ]);
    expect(rulingGroupKeys(keys)).toEqual([
      "cz|name:ustavnisoud|2007-04-03|plus38/6",
      "cz|name:ustavnisoud|2007-04-03|plus39/6",
    ]);
  });

  test("primary citations are not dockets and cannot satisfy docket presence", () => {
    for (const caseNumberType of [
      DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
    ]) {
      const citation = {
        ...decision,
        caseNumber: "502 U.S. 959",
        caseNumberType,
      };
      const withoutDocket = rulingKeysOf(citation);
      expect(withoutDocket.dockets).toEqual([]);
      expect(withoutDocket.defects).toContain("docket_absent");
      expect(rulingGroupKeys(withoutDocket)).toEqual([]);
      const withDocket = rulingKeysOf({
        ...citation,
        identifiers: [
          { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "90-7570" },
        ],
      });
      expect(withDocket.dockets).toEqual([
        { stated: "90-7570", key: "90/7570" },
      ]);
      expect(rulingGroupKeys(withDocket)).toHaveLength(1);
    }
    expect(
      rulingKeysOf({
        ...decision,
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      }).dockets,
    ).toEqual(rulingKeysOf(decision).dockets);
  });

  test("reports missing prerequisites and groups only digit-bearing dockets", () => {
    const absent = rulingKeysOf({ country: "CZ" });
    expect(absent.defects.toSorted()).toEqual([
      "court_absent",
      "date_absent",
      "docket_absent",
    ]);
    expect(absent).toMatchObject({
      court: { kind: "absent" },
      date: { kind: "absent" },
      ecli: { kind: "absent" },
      decisionKind: { kind: "absent" },
    });
    expect(rulingGroupKeys(absent)).toEqual([]);
    for (const input of [
      { ...decision, court: undefined },
      { ...decision, decisionDate: undefined },
      { ...decision, caseNumber: undefined },
      { ...decision, court: "\u200b \u00a0" },
      { ...decision, caseNumber: "---" },
    ]) {
      expect(rulingGroupKeys(rulingKeysOf(input))).toEqual([]);
    }
    const mixed = rulingKeysOf({
      ...decision,
      caseNumber: "letters",
      identifiers: [
        { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "38/06" },
      ],
    });
    expect(mixed.defects).toContain("docket_without_digits");
    expect(mixed.dockets).toHaveLength(2);
    expect(rulingGroupKeys(mixed)).toHaveLength(1);
  });

  test("dates, courts, countries, and component boundaries stay distinct", () => {
    const original = rulingGroupKeys(rulingKeysOf(decision));
    for (const input of [
      { ...decision, decisionDate: "2007-02-06" },
      { ...decision, court: "Nejvyšší soud" },
      { ...decision, country: "SK" },
    ]) {
      expect(rulingGroupKeys(rulingKeysOf(input))).not.toEqual(original);
    }
    expect(
      rulingGroupKeys(
        rulingKeysOf({ ...decision, country: "a|directory:b", courtId: "c" }),
      ),
    ).not.toEqual(
      rulingGroupKeys(
        rulingKeysOf({ ...decision, country: "a", courtId: "b|directory:c" }),
      ),
    );
    expect(
      rulingGroupKeys(rulingKeysOf({ ...decision, courtId: "a|b" })),
    ).not.toEqual(
      rulingGroupKeys(rulingKeysOf({ ...decision, courtId: "a%7Cb" })),
    );
  });

  test("decision kind discriminates values alongside the same group", () => {
    const judgment = {
      country: "PL",
      court: "Sąd Najwyższy",
      decisionDate: "2017-02-16",
      caseNumber: "I CSK 679/15",
    };
    const sentence = rulingKeysOf({ ...judgment, decisionType: "wyrok" });
    const order = rulingKeysOf({ ...judgment, decisionType: "postanowienie" });
    expect(rulingGroupKeys(sentence)).toEqual(rulingGroupKeys(order));
    expect(sentence.decisionKind).toMatchObject({ key: "wyrok" });
    expect(order.decisionKind).toMatchObject({ key: "postanowienie" });
  });
});

describe("language-independent comparison", () => {
  test.each([
    ["Ú", "u"],
    ["U\u0301", "u"],
    ["３８／０６", "38/06"],
    ["A–B—C−D‐E", "a-b-c-d-e"],
    [" A\u00a0B\u200bC\u200dD\u2060 ", "abcd"],
    ["NSNc", "nsnc"],
    ["NSNC", "nsnc"],
    ["ДЕЛО １２/０６", "дело12/06"],
    ["ΑΒ 12/06", "αβ12/06"],
    ["İ 38/06", "i38/06"],
    ["ΑΣ", "ασ"],
    ["Α Σ", "ασ"],
    ["ΑΣΑ", "ασα"],
    ["ΑΣ Α", "ασα"],
    ["ας", "ασ"],
  ])("folds %s to %s", (input, expected) => {
    expect(foldRulingIdentity(input)).toBe(expected);
  });

  test("normalization fixtures differ before folding", () => {
    expect(normalizeUnicode("Ú", "NFD")).not.toBe(normalizeUnicode("Ú", "NFC"));
    expect(normalizeUnicode("３８／０６", "NFKC")).not.toBe("３８／０６");
  });

  test("preserves separated digits, removes leading zeros, and never widens years", () => {
    expect(["38/06", "380/6", "3806"].map(docketOf)).toEqual([
      "38/6",
      "380/6",
      "3806",
    ]);
    expect(new Set(["38/06", "380/6", "3806"].map(docketOf)).size).toBe(3);
    for (const separator of [
      "/",
      ".",
      "-",
      "–",
      "—",
      "−",
      "‼",
      " ",
      "\u00a0",
      "\u200b",
    ]) {
      expect(docketOf(`0038${separator}0006`)).toBe("38/6");
    }
    expect(docketOf("III CSK ０００/００")).toBe("iiicsk0/0");
    expect(docketOf("III.CSK 38/06")).toBe(docketOf("IIICSK38/6"));
    expect(docketOf("38/06")).not.toBe(docketOf("38/2006"));
    expect(docketOf("ДЕЛО ٠٠٣٨/٠٦")).toBe("дело38/6");
    expect(docketOf("ΑΒ 12/06")).toBe("αβ12/6");
    expect(docketOf("38a6")).not.toBe(docketOf("38/6"));
    expect(docketOf("38/06-12")).toBe("38/6/12");
    expect(docketOf("Sygn. akt III KK 195/16")).toBe("sygnaktiiikk195/16");
  });

  test("is a fixed point and produces keys on arbitrary Unicode and lone surrogates", () => {
    fc.assert(
      fc.property(unicodeString, (input) => {
        const folded = foldRulingIdentity(input);
        expect(foldRulingIdentity(folded)).toBe(folded);
        expect(folded).not.toMatch(/[\p{M}\p{White_Space}\p{Cf}]/u);
        const keys = rulingKeysOf({
          country: input,
          court: input,
          caseNumber: input,
          decisionType: input,
          ecli: input,
          decisionDate: input,
        });
        expect(keys.version).toBe(1);
        expect(rulingGroupKeys(keys).length).toBeLessThanOrEqual(
          keys.dockets.length,
        );
      }),
      propertyConfig({ numRuns: 500 }),
    );
    expect(
      rulingGroupKeys(rulingKeysOf({ ...decision, court: "\ud800" })),
    ).toHaveLength(1);
  });

  test("canonical and compatibility input forms agree", () => {
    fc.assert(
      fc.property(unicodeString, (input) => {
        for (const normalization of ["NFC", "NFD", "NFKC"] as const) {
          expect(
            foldRulingIdentity(normalizeUnicode(input, normalization)),
          ).toBe(foldRulingIdentity(input));
          expect(docketOf(normalizeUnicode(input, normalization))).toBe(
            docketOf(input),
          );
        }
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("invisible characters and whitespace do not change court or kind folds", () => {
    fc.assert(
      fc.property(unicodeString, gaps, (input, separator) => {
        expect(foldRulingIdentity(Array.from(input).join(separator))).toBe(
          foldRulingIdentity(input),
        );
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("inserting gaps except between digits preserves docket identity", () => {
    fc.assert(
      fc.property(unicodeString, gaps, (input, separator) => {
        // Test after compatibility normalization: otherwise insertion can break
        // a ligature into a different sequence of alphanumeric boundaries.
        const points = Array.from(normalizeUnicode(input, "NFKC"));
        let spaced = "";
        for (const [index, point] of points.entries()) {
          const previous = points.at(index - 1);
          if (
            index > 0 &&
            !(previous && /\p{Nd}/u.test(previous) && /\p{Nd}/u.test(point))
          ) {
            spaced += separator;
          }
          spaced += point;
        }
        expect(docketOf(spaced)).toBe(docketOf(input));
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("invisible gaps between digits behave like a slash", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 0, max: 999_999 }),
        gaps,
        (left, right, gap) => {
          expect(docketOf(`${left}${gap}${right}`)).toBe(
            docketOf(`${left}/${right}`),
          );
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("decimal runs remain ordered without losing digits", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 999_999 }), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.constantFrom("/", ".", "–", "−"),
        (numbers, separator) => {
          const docket = numbers.map((number) => `00${number}`).join(separator);
          expect(docketOf(docket)?.split("/")).toEqual(numbers.map(String));
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });
});
