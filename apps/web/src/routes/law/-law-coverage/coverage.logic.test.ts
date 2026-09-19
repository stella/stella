import { describe, expect, test } from "bun:test";

import {
  caseLawCoverageCompletenessNotes,
  orderCoverageCountriesByName,
} from "@/routes/law/-law-coverage/coverage.logic";

describe("countries are ordered by the name the reader sees", () => {
  test("the reader's collation decides, not the ISO code", () => {
    // Codepoint order would give AUT, CZE, HUN; a Czech reader reads the
    // names, where "Ch" is a letter of its own sitting between H and I.
    const countries = [
      { country: "AUT", name: "Itálie" },
      { country: "CZE", name: "Chorvatsko" },
      { country: "HUN", name: "Haiti" },
    ];

    expect(
      orderCoverageCountriesByName({
        countries,
        locale: "cs",
        nameOf: ({ name }) => name,
      }).map(({ country }) => country),
    ).toEqual(["HUN", "CZE", "AUT"]);
  });

  test("the same names order differently under a different locale", () => {
    const countries = [
      { country: "AUT", name: "Itálie" },
      { country: "CZE", name: "Chorvatsko" },
      { country: "HUN", name: "Haiti" },
    ];

    expect(
      orderCoverageCountriesByName({
        countries,
        locale: "en",
        nameOf: ({ name }) => name,
      }).map(({ country }) => country),
    ).toEqual(["CZE", "HUN", "AUT"]);
  });

  test("the input is left untouched", () => {
    const countries = [{ country: "POL" }, { country: "AUT" }];

    orderCoverageCountriesByName({
      countries,
      locale: "en",
      nameOf: ({ country }) => country,
    });

    expect(countries.map(({ country }) => country)).toEqual(["POL", "AUT"]);
  });
});

describe("what a percentage leaves out is stated, never folded in", () => {
  test("each state gets its own count, the unmeasured ones first", () => {
    expect(
      caseLawCoverageCompletenessNotes({
        staleSources: 2,
        notCountedSources: 3,
        notMeasuredSources: 1,
      }),
    ).toEqual([
      { kind: "not-measured", count: 1 },
      { kind: "stale", count: 2 },
      { kind: "not-counted", count: 3 },
    ]);
  });

  test("a state with no sources in it says nothing", () => {
    expect(
      caseLawCoverageCompletenessNotes({
        staleSources: 0,
        notCountedSources: 0,
        notMeasuredSources: 4,
      }),
    ).toEqual([{ kind: "not-measured", count: 4 }]);
  });

  test("a source with a total but no count is stated, never folded in", () => {
    expect(
      caseLawCoverageCompletenessNotes({
        staleSources: 0,
        notCountedSources: 2,
        notMeasuredSources: 0,
      }),
    ).toEqual([{ kind: "not-counted", count: 2 }]);
  });

  test("a country whose every source is measured carries no note", () => {
    expect(
      caseLawCoverageCompletenessNotes({
        staleSources: 0,
        notCountedSources: 0,
        notMeasuredSources: 0,
      }),
    ).toEqual([]);
  });
});
