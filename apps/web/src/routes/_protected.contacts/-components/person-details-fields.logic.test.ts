import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { foldSearchMatchText } from "@stll/text-normalize";

import {
  birthDateDraft,
  filterNationalityOptions,
  normalizeBirthDateDigits,
  parseBirthDateDraft,
} from "@/routes/_protected.contacts/-components/person-details-fields.logic";

describe("person date of birth precision", () => {
  test("accepts Arabic and Eastern Arabic digits at the input boundary", () => {
    expect(normalizeBirthDateDigits("١٩٨٤")).toBe("1984");
    expect(normalizeBirthDateDigits("۱۹۸۴")).toBe("1984");
    expect(normalizeBirthDateDigits("２０００")).toBe("2000");
  });
  test("preserves year, month, and full-date precision", () => {
    expect(birthDateDraft({ precision: "year", year: 1984 })).toEqual({
      precision: "year",
      year: "1984",
      month: "",
      day: "",
    });
    expect(
      parseBirthDateDraft({
        precision: "month",
        year: "1984",
        month: "3",
        day: "",
      }),
    ).toEqual({ precision: "month", year: 1984, month: 3 });
    expect(
      parseBirthDateDraft({
        precision: "day",
        year: "2000",
        month: "2",
        day: "29",
      }),
    ).toEqual({ precision: "day", year: 2000, month: 2, day: 29 });
  });

  test("rejects unsupported years and invalid calendar dates", () => {
    expect(
      parseBirthDateDraft({
        precision: "year",
        year: "0999",
        month: "",
        day: "",
      }),
    ).toBeNull();
    expect(
      parseBirthDateDraft({
        precision: "day",
        year: "1900",
        month: "2",
        day: "29",
      }),
    ).toBeNull();
    expect(
      parseBirthDateDraft({
        precision: "day",
        year: "2000",
        month: "4",
        day: "31",
      }),
    ).toBeNull();
  });
});

describe("nationality query filtering", () => {
  const countries = [
    { code: "CZ", name: "Česká republika" },
    { code: "SK", name: "Slovensko" },
    { code: "TR", name: "İstanbul" },
    { code: "X[", name: "Novákovým (Česko)" },
  ];

  test("trims the query, matches name or code, and preserves order", () => {
    expect(
      filterNationalityOptions({
        countries,
        query: "  ČESK  ",
      }),
    ).toEqual(countries.slice(0, 1).concat(countries.slice(3, 4)));
    expect(
      filterNationalityOptions({
        countries,
        query: "cz",
      }),
    ).toEqual(countries.slice(0, 1));
    expect(
      filterNationalityOptions({
        countries,
        query: "  ",
      }),
    ).toEqual(countries);
    expect(filterNationalityOptions({ countries: [], query: "cz" })).toEqual(
      [],
    );
  });

  test("ignores accents and case, keeps punctuation literal and fields apart", () => {
    expect(
      filterNationalityOptions({
        countries,
        query: "cesk",
      }),
    ).toEqual(countries.slice(0, 1).concat(countries.slice(3, 4)));
    expect(
      filterNationalityOptions({
        countries,
        query: "NOVAKOV",
      }),
    ).toEqual(countries.slice(3, 4));
    expect(
      filterNationalityOptions({
        countries,
        query: "novákov",
      }),
    ).toEqual(countries.slice(3, 4));
    expect(
      filterNationalityOptions({
        countries,
        query: "[",
      }),
    ).toEqual(countries.slice(3, 4));
    expect(
      filterNationalityOptions({
        countries,
        query: "republika cz",
      }),
    ).toEqual([]);
    expect(
      filterNationalityOptions({
        countries,
        query: "česko x[",
      }),
    ).toEqual([]);
  });

  test("matches replacement scalars for lone surrogates without splitting astral names", () => {
    const options = [
      { name: "a\ud800b", code: "x" },
      { name: "😀", code: "y" },
    ];
    expect(
      filterNationalityOptions({
        countries: options,
        query: "\udc00",
      }),
    ).toEqual(options.slice(0, 1));
    expect(
      filterNationalityOptions({
        countries: options,
        query: "�",
      }),
    ).toEqual(options.slice(0, 1));
  });

  test("dotted and dotless I match plain i in every UI locale", () => {
    expect(
      filterNationalityOptions({
        countries,
        query: "istan",
      }),
    ).toEqual(countries.slice(2, 3));
    expect(
      filterNationalityOptions({
        countries,
        query: "ISTAN",
      }),
    ).toEqual(countries.slice(2, 3));
  });
});

test("nationality filtering keeps exactly the options a field of which matches", () => {
  const TEST_TEXT_LENGTH = 30;
  const TEST_COUNTRY_COUNT = 10;
  const text = fc
    .array(
      fc.constantFrom(
        "Č",
        "č",
        "á",
        "a",
        "İ",
        "I",
        "ı",
        " ",
        "[",
        ".",
        "😀",
        "\ud800",
        "s",
        "k",
      ),
      { maxLength: TEST_TEXT_LENGTH },
    )
    .map((parts) => parts.join(""));
  const matchesFolded = (field: string, needle: string) =>
    foldSearchMatchText(field.toWellFormed()).includes(
      foldSearchMatchText(needle.trim().toWellFormed()),
    );
  assertProperty(
    "nationality filtering keeps exactly the options a field of which matches",
    fc.property(
      fc.array(fc.record({ name: text, code: text }), {
        maxLength: TEST_COUNTRY_COUNT,
      }),
      text,
      (countries, query) => {
        expect(filterNationalityOptions({ countries, query })).toEqual(
          countries.filter(
            ({ name, code }) =>
              matchesFolded(name, query) || matchesFolded(code, query),
          ),
        );
      },
    ),
  );
});
