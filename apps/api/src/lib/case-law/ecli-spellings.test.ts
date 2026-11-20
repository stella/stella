import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { normalizeDecisionIdentifierIn } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { ecliPublisherSpellings } from "@/api/lib/case-law/ecli-spellings";

/** As the identifier index stores an ECLI. */
const stored = (ecli: string) =>
  normalizeDecisionIdentifierIn("CZE", {
    type: DECISION_IDENTIFIER_TYPES.ECLI,
    value: ecli,
  });

const keysOf = (ecli: string) =>
  new Set(ecliPublisherSpellings("CZE", ecli).map(stored));

describe("Czech ECLI publisher spellings", () => {
  // Pairs measured on the same decisions in the Supreme Court's collection
  // and in the court decision databases. The docket year reads both ways.
  const samePairs = [
    ["ECLI:CZ:NS:1999:2.CDON.1548.1997.1", "ECLI:CZ:NS:1999:2.CDON.1548.97.1"],
    ["ECLI:CZ:KSPL:1999:14.CO.547.1999.1", "ECLI:CZ:KSPL:1999:14.CO.547.99.1"],
  ] as const;

  for (const [collection, held] of samePairs) {
    test(`${collection} reaches ${held}, and back`, () => {
      // The fixture differs as stored, so the match is not vacuous.
      expect(stored(collection)).not.toBe(stored(held));
      expect(keysOf(collection).has(stored(held))).toBe(true);
      expect(keysOf(held).has(stored(collection))).toBe(true);
    });
  }

  test("a register with its diacritic reaches its ASCII spelling", () => {
    const collection = "ECLI:CZ:NS:2019:29.NSČR.106.2018.1";
    const held = "ECLI:CZ:NS:2019:29.NSCR.106.2018.1";
    expect(stored(collection)).not.toBe(stored(held));
    // Folding is one way: the ASCII spelling does not say which letter
    // carried the mark, and the decision databases store the ASCII one.
    expect(keysOf(collection).has(stored(held))).toBe(true);
  });

  test("another decision of the same file is never reached", () => {
    const keys = keysOf("ECLI:CZ:NS:1999:2.CDON.1548.97.1");
    expect(keys.has(stored("ECLI:CZ:NS:1999:2.CDON.1548.97.2"))).toBe(false);
    expect(keys.has(stored("ECLI:CZ:NS:1999:2.CDON.1549.97.1"))).toBe(false);
    expect(keys.has(stored("ECLI:CZ:NS:1999:2.CDON.1548.1897.1"))).toBe(false);
  });

  test("the stated spelling comes first, and other countries keep only it", () => {
    expect(
      ecliPublisherSpellings("CZE", "ECLI:CZ:US:2025:Pl.US.32.25.1")[0],
    ).toBe("ECLI:CZ:US:2025:Pl.US.32.25.1");
    expect(
      ecliPublisherSpellings("SVK", "ECLI:SK:NSSR:1999:1.CDO.1.97.1"),
    ).toEqual(["ECLI:SK:NSSR:1999:1.CDO.1.97.1"]);
  });

  test("an ordinal outside the docket grammar is its own only spelling", () => {
    expect(ecliPublisherSpellings("CZE", "ECLI:CZ:NS:1999:R.9.1971")).toEqual([
      "ECLI:CZ:NS:1999:R.9.1971",
    ]);
  });
});

test.each(["ECLI:EU:C:2024:9", "EU:C:2024:9"])(
  "European full and printed short ECLIs share lookup spellings: %s",
  (value) => {
    const variants = ecliPublisherSpellings("EU", value);
    expect(variants.at(0)).toBe(value);
    expect(new Set(variants)).toEqual(
      new Set(["ECLI:EU:C:2024:9", "EU:C:2024:9"]),
    );
  },
);

test("European aliases preserve decision identity and reject embedded or unsupported short forms", () => {
  expect(
    ecliPublisherSpellings("EU", "See ECLI:EU:C:2024:9 in context"),
  ).toEqual(["See ECLI:EU:C:2024:9 in context"]);
  expect(ecliPublisherSpellings("EU", "ECLI:EU:OTHER:2024:9")).toEqual([
    "ECLI:EU:OTHER:2024:9",
  ]);
  expect(ecliPublisherSpellings("EU", "ECLI:EU:C:2024:9")).not.toContain(
    "EU:C:2024:10",
  );
});
