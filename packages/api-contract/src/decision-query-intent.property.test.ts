import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { parseDecisionQuery } from "./decision-query-intent";

const canonicalDockets = [
  "22 Cdo 2653/2012",
  "29 NSČR 55/2013",
  "1 As 12/2020",
  "IV. ÚS 23/05",
  "II CSK 123/19",
  "C-131/12",
  "T-449/14",
  "5Ob200/20x",
  "Ra 2020/01/0001",
  "E 123/2019-12",
] as const;

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
    fc.stringMatching(/^[a-záčďéěíňóřšťúůýž]{2,10}$/u),
    fc.array(operators, { minLength: 1, maxLength: 5 }),
  )
  .map(([before, word, after]) => `${before.join("")}${word}${after.join("")}`);

describe("case-law query parser properties", () => {
  test(
    "canonical docket values parse to a stable canonical identifier",
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constantFrom(...canonicalDockets),
            fc
              .tuple(
                fc.integer({ min: 1, max: 99 }),
                fc.integer({ min: 1, max: 999_999 }),
                fc.integer({ min: 1900, max: 2099 }),
              )
              .map(
                ([senate, ordinal, year]) => `${senate} Cdo ${ordinal}/${year}`,
              ),
          ),
          (docket) => {
            const first = parseDecisionQuery(docket);
            expect(first).toMatchObject({ type: "identifier", kind: "docket" });
            if (first.type !== "identifier" || first.kind !== "docket") {
              return;
            }

            expect(parseDecisionQuery(first.value)).toEqual(first);
          },
        ),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "operator shaped unrecognized entries remain intact text",
    () => {
      fc.assert(
        fc.property(adversarialText, (text) => {
          expect(parseDecisionQuery(text)).toEqual({ type: "text", text });
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );
});
