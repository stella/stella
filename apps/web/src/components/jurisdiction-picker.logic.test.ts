import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { compareByLocale } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import { filterJurisdictionOptions } from "@/components/jurisdiction-picker.logic";

const countries = [
  { code: "DE", name: "Germany" },
  { code: "AT", name: "Austria" },
  { code: "BE", name: "Belgium" },
  { code: "CZ", name: "Česko" },
];
const PROPERTY_TEXT_PARTS_MAX = 24;
const PROPERTY_COUNTRIES_MAX = 16;
const PROPERTY_SELECTED_CODES_MAX = 8;
const PROPERTY_SUGGESTED_CODES_MAX = 8;

/**
 * The search contract: a field matches when it contains the trimmed query once
 * both are folded for search (case, accents, ligatures, Arabic variants).
 */
const matchesFolded = (field: string | null | undefined, query: string) => {
  const needle = foldSearchMatchText(query.trim().toWellFormed());
  return (
    needle === "" ||
    (field !== null &&
      field !== undefined &&
      foldSearchMatchText(field.toWellFormed()).includes(needle))
  );
};

const filter = (
  query: string,
  {
    selectedCodes = [],
    suggestedCodes = [],
    options = countries,
  }: {
    selectedCodes?: readonly string[];
    suggestedCodes?: readonly string[];
    options?: typeof countries;
  } = {},
) =>
  filterJurisdictionOptions({
    countries: options,
    locale: "en",
    query,
    selectedCodes,
    suggestedCodes,
  });

describe("jurisdiction search", () => {
  test("trims and folds a query against names or codes independently", () => {
    expect(filter("  at ").map(({ code }) => code)).toEqual(["AT"]);
    expect(filter("  ger ").map(({ code }) => code)).toEqual(["DE"]);
    expect(filter("a be")).toEqual([]);
    expect(filter("   ")).toHaveLength(countries.length);
  });

  test("ignores accents and preserves selected, suggested, then locale order", () => {
    expect(filter("cesko").map(({ code }) => code)).toEqual(["CZ"]);
    expect(filter("ČESKO").map(({ code }) => code)).toEqual(["CZ"]);
    expect(
      filter("", {
        selectedCodes: ["BE"],
        suggestedCodes: ["DE", "AT"],
      }).map(({ code }) => code),
    ).toEqual(["BE", "AT", "DE", "CZ"]);
  });

  test("handles empty input and does not cap matching countries", () => {
    expect(filter("at", { options: [] })).toEqual([]);
    const manyCountries = Array.from({ length: 40 }, (_, index) => ({
      code: `X${index}`,
      name: `Country ${index}`,
    }));
    expect(filter("x", { options: manyCountries })).toHaveLength(40);
  });

  test("matches malformed UTF-16 through the replacement character", () => {
    expect(
      filter("\uFFFD", {
        options: [{ code: "ZZ", name: "A\ud800land" }],
      }).map(({ code }) => code),
    ).toEqual(["ZZ"]);
  });
});

test("jurisdiction filtering keeps the folded matches in selection order", () => {
  const text = fc
    .array(
      fc.constantFrom(
        "a",
        "A",
        " ",
        "\t",
        "é",
        "e\u0301",
        "Ł",
        "İ",
        "ı",
        "ß",
        "[",
        ".",
        "😀",
        "\ud800",
        "ع",
      ),
      { maxLength: PROPERTY_TEXT_PARTS_MAX },
    )
    .map((parts) => parts.join(""));

  assertProperty(
    "jurisdiction filtering keeps the folded matches in selection order",
    fc.property(
      fc.array(fc.record({ code: text, name: text }), {
        maxLength: PROPERTY_COUNTRIES_MAX,
      }),
      fc.array(text, { maxLength: PROPERTY_SELECTED_CODES_MAX }),
      fc.array(text, { maxLength: PROPERTY_SUGGESTED_CODES_MAX }),
      text,
      fc.constantFrom("en", "cs", "tr"),
      (generatedCountries, selectedCodes, suggestedCodes, query, locale) => {
        const selected = new Set(selectedCodes);
        const suggested = new Set(suggestedCodes);
        const compareName = compareByLocale(locale);
        const sorted = generatedCountries.toSorted((a, b) => {
          const aSelected = selected.has(a.code);
          const bSelected = selected.has(b.code);
          if (aSelected !== bSelected) {
            return aSelected ? -1 : 1;
          }
          const aSuggested = suggested.has(a.code);
          const bSuggested = suggested.has(b.code);
          if (aSuggested !== bSuggested) {
            return aSuggested ? -1 : 1;
          }
          return compareName(a.name, b.name);
        });
        const expected = sorted.filter(
          (country) =>
            matchesFolded(country.name, query) ||
            matchesFolded(country.code, query),
        );

        expect(
          filterJurisdictionOptions({
            countries: generatedCountries,
            locale,
            query,
            selectedCodes,
            suggestedCodes,
          }),
        ).toEqual(expected);
      },
    ),
  );
});
