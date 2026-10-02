import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { parseStatuteQuery } from "./statute-query-intent";

const number = fc.integer({ min: 1, max: 99_999 });
const year = fc.integer({ min: 1800, max: 2099 });

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
      assertProperty(
        "canonical Czech and Slovak act values parse back to the same act",
        fc.property(
          number,
          year,
          fc.constantFrom(
            { country: "cze", suffix: "", collection: "sb" } as const,
            { country: "cze", suffix: " Sb.", collection: "sb" } as const,
            { country: "svk", suffix: "", collection: "zz" } as const,
            { country: "svk", suffix: " Z. z.", collection: "zz" } as const,
          ),
          (n, y, { country, suffix, collection }) => {
            const parsed = parseStatuteQuery(country, `${n}/${y}${suffix}`);
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
                  country,
                  `${parsed.number}/${parsed.year}${suffix}`,
                ),
              ).toEqual(parsed);
            }
          },
        ),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "operator shaped unrecognized entries remain intact title text",
    () => {
      assertProperty(
        "operator shaped unrecognized entries remain intact title text",
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
      );
    },
    propertyTestTimeout(10_000),
  );
});
