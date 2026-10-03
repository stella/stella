import { describe, expect, test } from "bun:test";

import { isStatuteQueryCountry } from "./statute-aliases";
import {
  STATUTE_GAZETTES,
  statuteGazetteAbbreviation,
} from "./statute-gazette";
import { parseStatuteQuery } from "./statute-query-intent";

const spellings = Object.entries(STATUTE_GAZETTES).flatMap(
  ([country, collections]) =>
    Object.entries(collections).flatMap(([eliCollection, byYear]) =>
      byYear.map(({ fromYear, abbreviation }) => ({
        country,
        eliCollection,
        year: Math.max(fromYear, 1950),
        abbreviation,
      })),
    ),
);

describe("a gazette's printed abbreviation and its ELI segment", () => {
  test("no ELI segment belongs to two countries", () => {
    const segments = Object.values(STATUTE_GAZETTES).flatMap((collections) =>
      Object.keys(collections),
    );
    expect(new Set(segments).size).toBe(segments.length);
  });

  test.each(spellings)(
    "$abbreviation labels and addresses $eliCollection",
    ({ country, eliCollection, year, abbreviation }) => {
      expect(statuteGazetteAbbreviation(eliCollection, year)).toBe(
        abbreviation,
      );
      expect(isStatuteQueryCountry(country)).toBe(true);
      if (!isStatuteQueryCountry(country)) {
        return;
      }
      expect(
        parseStatuteQuery(country, `57/${String(year)} ${abbreviation}`),
      ).toMatchObject({ type: "act", collection: eliCollection });
    },
  );

  test("a collection without a known abbreviation has none", () => {
    expect(statuteGazetteAbbreviation("ul1", 2004)).toBeNull();
  });
});
