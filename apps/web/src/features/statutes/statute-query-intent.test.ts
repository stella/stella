import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { STATUTE_ALIASES } from "@/features/statutes/statute-aliases";
import {
  foldStatuteQuery,
  parseStatuteQuery,
} from "@/features/statutes/statute-query-intent";
import { STATUTE_COUNTRIES, type StatuteCountry } from "@/lib/statute-route";

const countries = Object.keys(STATUTE_COUNTRIES).filter(
  (country): country is StatuteCountry => country in STATUTE_COUNTRIES,
);

const SPACES = [" ", "  ", " ", "　", "\t", ""] as const;

const number = fc.integer({ min: 1, max: 99_999 });
const year = fc.integer({ min: 1918, max: 2026 });
const space = fc.constantFrom(...SPACES);
const prefix = fc.constantFrom(
  "",
  "č. ",
  "zákon ",
  "zákon č. ",
  "z. ",
  "zák. ",
  "vyhláška ",
  "ZÁKON Č. ",
);
const czechSuffix = fc.constantFrom(
  ["", null],
  ["Sb.", "sb"],
  ["Sb", "sb"],
  ["sb.", "sb"],
  ["SB.", "sb"],
  ["Ú. l.", null],
  ["Ú.l. I", null],
);
const slovakSuffix = fc.constantFrom(
  ["", null],
  ["Zb.", "zz"],
  ["Z. z.", "zz"],
  ["Z.z.", "zz"],
  ["z. z", "zz"],
  ["ZB", "zz"],
);

const spelled = (parts: readonly string[], spaces: readonly string[]): string =>
  parts.map((part, index) => `${part}${spaces[index] ?? ""}`).join("");

describe("reading an act number", () => {
  test("every lenient spelling of a Czech number names the same act", () => {
    fc.assert(
      fc.property(
        number,
        year,
        prefix,
        czechSuffix,
        fc.array(space, { minLength: 4, maxLength: 4 }),
        (n, y, pre, [suffix, collection], spaces) => {
          const raw = spelled([pre, String(n), "/", String(y), suffix], spaces);

          expect(parseStatuteQuery("cze", raw)).toEqual({
            type: "act",
            collection,
            label: null,
            number: String(n),
            provision: null,
            year: String(y),
          });
        },
      ),
      propertyConfig(),
    );
  });

  test("every lenient spelling of a Slovak number names the same act", () => {
    fc.assert(
      fc.property(
        number,
        year,
        slovakSuffix,
        fc.array(space, { minLength: 3, maxLength: 3 }),
        (n, y, [suffix, collection], spaces) => {
          const raw = spelled([String(n), "/", String(y), suffix], spaces);

          expect(parseStatuteQuery("svk", raw)).toEqual({
            type: "act",
            collection,
            label: null,
            number: String(n),
            provision: null,
            year: String(y),
          });
        },
      ),
      propertyConfig(),
    );
  });

  test("full-width digits and leading zeros read as the same number", () => {
    expect(parseStatuteQuery("cze", "０８９／２０１２")).toMatchObject({
      type: "act",
      number: "89",
      year: "2012",
    });
  });

  test("a provision ahead of the number is kept as a jump target", () => {
    expect(parseStatuteQuery("cze", "§ 2079 zákona č. 89/2012 Sb.")).toEqual({
      type: "act",
      collection: "sb",
      label: null,
      number: "89",
      provision: "§ 2079",
      year: "2012",
    });
    expect(parseStatuteQuery("cze", "§2079 odst. 1 OZ")).toMatchObject({
      type: "act",
      number: "89",
      provision: "§ 2079",
      label: "Občanský zákoník",
    });
    expect(parseStatuteQuery("cze", "čl. 10 ústava")).toMatchObject({
      type: "act",
      number: "1",
      provision: "cl. 10",
    });
  });

  test("text that is not a reference searches titles verbatim", () => {
    expect(parseStatuteQuery("cze", "  občanský zákoník 2012 ")).toEqual({
      type: "text",
      text: "občanský zákoník 2012",
    });
    expect(parseStatuteQuery("cze", "89/12")).toEqual({
      type: "text",
      text: "89/12",
    });
    // A collection the jurisdiction does not publish must not widen the
    // number to every collection: 40/1964 Sb. is a different act.
    expect(parseStatuteQuery("cze", "40/1964 Z. z.")).toEqual({
      type: "text",
      text: "40/1964 Z. z.",
    });
    expect(parseStatuteQuery("svk", "89/2012 Sb.")).toEqual({
      type: "text",
      text: "89/2012 Sb.",
    });
    expect(parseStatuteQuery("cze", "")).toEqual({ type: "empty" });
    expect(parseStatuteQuery("cze", "§ 2079")).toEqual({
      type: "text",
      text: "§ 2079",
    });
  });
});

describe("reading an alias", () => {
  test("every alias of every jurisdiction resolves to its act, however cased", () => {
    for (const country of countries) {
      for (const [alias, target] of Object.entries(STATUTE_ALIASES[country])) {
        // Aliases are stored folded; a stored key that is not its own fold
        // could never be typed.
        expect(foldStatuteQuery(alias)).toBe(alias);
        for (const typed of [alias, alias.toUpperCase(), ` ${alias} `]) {
          expect(parseStatuteQuery(country, typed)).toEqual({
            type: "act",
            collection: target.collection,
            label: target.label,
            number: target.number,
            provision: null,
            year: target.year,
          });
        }
      }
    }
  });

  test("the same alias opens a different act per jurisdiction", () => {
    expect(parseStatuteQuery("cze", "OZ")).toMatchObject({
      number: "89",
      year: "2012",
    });
    expect(parseStatuteQuery("svk", "OZ")).toMatchObject({
      number: "40",
      year: "1964",
    });
  });

  test("diacritics and abbreviation dots are not required", () => {
    expect(parseStatuteQuery("cze", "Občanský zákoník")).toMatchObject({
      number: "89",
      year: "2012",
    });
    expect(parseStatuteQuery("cze", "obc. zak.")).toMatchObject({
      number: "89",
    });
    expect(parseStatuteQuery("cze", "OSŘ")).toMatchObject({ number: "99" });
    expect(parseStatuteQuery("cze", "sřs")).toMatchObject({ number: "150" });
    expect(parseStatuteQuery("svk", "Obchodný zákonník")).toMatchObject({
      number: "513",
    });
  });
});
