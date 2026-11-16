import { describe, expect, test } from "bun:test";

import { orderCoverageCountriesByName } from "@/routes/law/-law-coverage/coverage.logic";

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
