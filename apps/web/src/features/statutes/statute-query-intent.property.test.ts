import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { parseStatuteQuery } from "@/features/statutes/statute-query-intent";

const number = fc.integer({ min: 1, max: 99_999 });
const year = fc.integer({ min: 1800, max: 2099 });
const czechSuffix = fc.constantFrom(
  ["", null] as const,
  [" Sb.", "sb"] as const,
);
const slovakSuffix = fc.constantFrom(
  ["", null] as const,
  [" Z. z.", "zz"] as const,
);

const operators = fc.constantFrom(
  "AND",
  "OR",
  "NOT",
  ":",
  "*",
  "~",
  "(",
  ")",
  "+",
  "-",
  "\\",
  '"',
  "'",
  "§",
  "—",
  "„",
  "”",
);

const adversarialText = fc
  .tuple(
    fc.array(operators, { minLength: 1, maxLength: 5 }),
    fc.stringMatching(/^[a-z]{3,10}$/u),
    fc.array(operators, { minLength: 1, maxLength: 5 }),
  )
  .map(([before, word, after]) => `${before.join("")}${word}${after.join("")}`);

describe("statute query parser properties", () => {
  test(
    "canonical Czech and Slovak act values parse back to the same act",
    () => {
      fc.assert(
        fc.property(number, year, czechSuffix, (n, y, [suffix, collection]) => {
          const parsed = parseStatuteQuery("cze", `${n}/${y}${suffix}`);
          expect(parsed).toEqual({
            type: "act",
            collection,
            label: null,
            number: String(n),
            provision: null,
            year: String(y),
          });
          if (parsed.type === "act") {
            expect(
              parseStatuteQuery(
                "cze",
                `${parsed.number}/${parsed.year}${suffix}`,
              ),
            ).toEqual(parsed);
          }
        }),
        propertyConfig({ seed: propertySeed() }),
      );
      fc.assert(
        fc.property(
          number,
          year,
          slovakSuffix,
          (n, y, [suffix, collection]) => {
            const parsed = parseStatuteQuery("svk", `${n}/${y}${suffix}`);
            expect(parsed).toEqual({
              type: "act",
              collection,
              label: null,
              number: String(n),
              provision: null,
              year: String(y),
            });
            if (parsed.type === "act") {
              expect(
                parseStatuteQuery(
                  "svk",
                  `${parsed.number}/${parsed.year}${suffix}`,
                ),
              ).toEqual(parsed);
            }
          },
        ),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "operator shaped unrecognized entries remain intact title text",
    () => {
      fc.assert(
        fc.property(adversarialText, (text) => {
          expect(parseStatuteQuery("cze", text)).toEqual({
            type: "text",
            text,
          });
          expect(parseStatuteQuery("svk", text)).toEqual({
            type: "text",
            text,
          });
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );
});
