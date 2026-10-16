import { describe, expect, test } from "bun:test";

import {
  parseStatuteEliIdentity,
  statuteEliYearPattern,
} from "./statute-identity";

const STATUTE_ELI_IDENTITY_FIXTURES = [
  {
    eli: "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
    identity: { collection: "sb", number: "89", year: "2012" },
  },
  {
    eli: "https://www.slov-lex.sk/eli/sk/zz/1964/40",
    identity: { collection: "zz", number: "40", year: "1964" },
  },
  {
    eli: "https://www.slov-lex.sk/eli/sk/zz/2015/300",
    identity: { collection: "zz", number: "300", year: "2015" },
  },
  {
    eli: "CZ/2012/89",
    identity: { collection: null, number: null, year: null },
  },
] as const satisfies readonly {
  eli: Parameters<typeof parseStatuteEliIdentity>[0];
  identity: ReturnType<typeof parseStatuteEliIdentity>;
}[];

describe("statute ELI identity", () => {
  test.each(STATUTE_ELI_IDENTITY_FIXTURES)(
    "reads the published identity of $eli",
    ({ eli, identity }) => {
      expect(parseStatuteEliIdentity(eli)).toEqual(identity);
    },
  );

  test.each([
    { eli: null },
    { eli: undefined },
    { eli: "/eli/cz/sb/2012/123456" },
    { eli: "/eli/cz/sb/2012/89x" },
    { eli: "/eli/cz/sb/٢٠١٢/89" },
    { eli: "/eli/cz/sb/2012/٨٩" },
  ])("does not invent identity parts for $eli", ({ eli }) => {
    expect(parseStatuteEliIdentity(eli)).toEqual({
      collection: null,
      number: null,
      year: null,
    });
  });

  test("normalizes leading ordinal zeroes and retains a versioned act identity", () => {
    expect(parseStatuteEliIdentity("/eli/cz/sb/2012/00089/2024-01-01")).toEqual(
      {
        collection: "sb",
        number: "89",
        year: "2012",
      },
    );
  });

  test("a year predicate matches exactly the identities parsed for that year", () => {
    for (const year of ["2012", "1964", "2015"]) {
      const predicate = new RegExp(statuteEliYearPattern(year), "u");
      for (const { eli } of STATUTE_ELI_IDENTITY_FIXTURES) {
        expect(predicate.test(eli)).toBe(
          parseStatuteEliIdentity(eli).year === year,
        );
        expect(predicate.test(`${eli}/2026-01-01`)).toBe(
          parseStatuteEliIdentity(`${eli}/2026-01-01`).year === year,
        );
      }
    }
  });
});
