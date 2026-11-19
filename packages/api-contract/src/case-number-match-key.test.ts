import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  assertProperty,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { caseNumberMatchKey } from "./case-number-match-key";

describe("caseNumberMatchKey", () => {
  test.each([
    // A trailing full year of the 1900s or 2000s reads as two digits.
    ["c-679/2018", "c-679/18"],
    ["ivús452/2011", "ivús452/11"],
    ["24csp/61/2026", "24csp/61/26"],
    ["4as/1999", "4as/99"],
    ["4as/2099", "4as/99"],
    ["4as/1900", "4as/00"],
    // A sheet after the year rides along.
    ["c-679/2018-1", "c-679/18-1"],
    ["8as287/2020-33", "8as287/20-33"],
    // Already two digits, or no year where the tail reads one.
    ["c-158/21", "c-158/21"],
    ["c-679/18-1", "c-679/18-1"],
    ["88-1048", "88-1048"],
    ["p.20056/2005/52", "p.20056/2005/52"],
    // The year must be four digits of the 1900s or 2000s, right after a slash.
    ["4as/1899", "4as/1899"],
    ["4as/2100", "4as/2100"],
    ["4as/201", "4as/201"],
    ["4as/20181", "4as/20181"],
    ["4as2018", "4as2018"],
    ["4as-2018", "4as-2018"],
    ["4as/2018a", "4as/2018a"],
    // An empty sheet is no sheet: the tail does not read.
    ["c-679/2018-", "c-679/2018-"],
    ["c-679/2018 - 1", "c-679/2018 - 1"],
    // Non-ASCII digits are not a year.
    ["4as/٢٠١٨", "4as/٢٠١٨"],
    ["", ""],
    ["/2018", "/18"],
  ])("%p reads as %p", (key, matchKey) => {
    expect(caseNumberMatchKey(key)).toBe(matchKey);
  });

  const prefix = fc.stringMatching(/^[a-zà-ž0-9.\-/ ]{0,24}$/u);
  const fullYear = fc.integer({ min: 1900, max: 2099 });
  const sheet = fc.option(fc.integer({ min: 0, max: 99_999 }), {
    nil: undefined,
  });

  test(
    "a key printed with its full year matches the two-digit printing",
    () => {
      assertProperty(
        "full and two-digit years key alike",
        fc.property(prefix, fullYear, sheet, (head, year, page) => {
          const tail = page === undefined ? "" : `-${String(page)}`;
          const full = `${head}/${String(year)}${tail}`;
          const short = `${head}/${String(year).slice(2)}${tail}`;
          expect(caseNumberMatchKey(full)).toBe(short);
          expect(caseNumberMatchKey(short)).toBe(caseNumberMatchKey(short));
        }),
        { seed: propertySeed() },
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "the match key is idempotent and keeps everything before the year",
    () => {
      assertProperty(
        "folding twice is folding once; the head survives",
        fc.property(fc.string({ maxLength: 40 }), (key) => {
          const folded = caseNumberMatchKey(key);
          expect(caseNumberMatchKey(folded)).toBe(folded);
          const head = key.slice(0, key.lastIndexOf("/") + 1);
          expect(folded.startsWith(head)).toBe(true);
          expect(
            folded.length === key.length || folded.length === key.length - 2,
          ).toBe(true);
        }),
        { seed: propertySeed() },
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "a key ending in anything but digits keeps its spelling",
    () => {
      assertProperty(
        "no trailing year, no change",
        fc.property(
          fc.string({ maxLength: 30 }),
          fc.constantFrom("a", "x", ".", "/", " ", "ú"),
          (head, last) => {
            const key = `${head}${last}`;
            expect(caseNumberMatchKey(key)).toBe(key);
          },
        ),
        { seed: propertySeed() },
      );
    },
    propertyTestTimeout(10_000),
  );
});
