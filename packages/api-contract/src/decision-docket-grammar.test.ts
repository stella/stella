import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  canonicalDecisionDocket,
  DECISION_DOCKET_GRAMMARS,
  decisionDocketGrammarForJurisdiction,
  formatDecisionDocket,
} from "./decision-docket-grammar";
import type { DecisionDocketJurisdiction } from "./decision-docket-grammar";
import { DECISION_DOCKET_GRAMMAR_FIXTURES } from "./decision-docket-grammar.fixtures";

const canonicalDocketArbitraries = {
  AUT: fc.oneof(
    fc
      .tuple(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1, max: 99_999 }),
        fc.integer({ min: 0, max: 99 }),
      )
      .map(
        ([senate, ordinal, year]) =>
          `${senate} Xy ${ordinal}/${year.toString().padStart(2, "0")}x`,
      ),
    fc
      .tuple(
        fc.integer({ min: 1900, max: 2099 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 9999 }),
      )
      .map(
        ([year, registry, ordinal]) =>
          `Ra ${year}/${registry.toString().padStart(2, "0")}/${ordinal
            .toString()
            .padStart(4, "0")}`,
      ),
  ),
  CZE: fc.oneof(
    fc
      .tuple(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 1900, max: 2099 }),
      )
      .map(([senate, ordinal, year]) => `${senate} Xyz ${ordinal}/${year}`),
    fc
      .tuple(
        fc.constantFrom("I", "II", "III", "IV"),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 0, max: 99 }),
      )
      .map(
        ([chamber, ordinal, year]) =>
          `${chamber}. XÝ ${ordinal}/${year.toString().padStart(2, "0")}`,
      ),
  ),
  EU: fc
    .tuple(
      fc.constantFrom("C", "T", "F"),
      fc.integer({ min: 1, max: 9999 }),
      fc.integer({ min: 0, max: 99 }),
      fc.boolean(),
    )
    .map(
      ([court, ordinal, year, appeal]) =>
        `${court}-${ordinal}/${year.toString().padStart(2, "0")}${
          appeal ? " P" : ""
        }`,
    ),
  POL: fc
    .tuple(
      fc.constantFrom("I", "II", "III", "IV", "V"),
      fc.integer({ min: 1, max: 999_999 }),
      fc.integer({ min: 0, max: 99 }),
    )
    .map(
      ([chamber, ordinal, year]) =>
        `${chamber} XYZ ${ordinal}/${year.toString().padStart(2, "0")}`,
    ),
  SVK: fc
    .tuple(
      fc.integer({ min: 1, max: 999 }),
      fc.integer({ min: 1, max: 999_999 }),
      fc.integer({ min: 1900, max: 2099 }),
    )
    .map(([senate, ordinal, year]) => `${senate}Xyz/${ordinal}/${year}`),
} as const satisfies Record<DecisionDocketJurisdiction, Arbitrary<string>>;

describe("declared decision docket grammars", () => {
  test("scope lookup is case-insensitive and unknown scopes stay absent", () => {
    expect(decisionDocketGrammarForJurisdiction("pol")).toBe(
      DECISION_DOCKET_GRAMMARS.POL,
    );
    expect(decisionDocketGrammarForJurisdiction("unknown")).toBeNull();
  });

  for (const grammar of Object.values(DECISION_DOCKET_GRAMMARS)) {
    test(`${grammar.jurisdiction} format is a parse fixed point`, () => {
      fc.assert(
        fc.property(
          canonicalDocketArbitraries[grammar.jurisdiction],
          (canonical) => {
            const parsed = grammar.parse(canonical);
            expect(parsed).not.toBeNull();
            if (parsed === null) {
              return;
            }
            expect(grammar.parse(formatDecisionDocket(parsed))).toEqual(parsed);
          },
        ),
        propertyConfig(),
      );
    });

    test(`${grammar.jurisdiction} variants share one canonical value`, () => {
      const fixtures = DECISION_DOCKET_GRAMMAR_FIXTURES[grammar.jurisdiction];
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const base = grammar.parse(fixture.canonical);
        expect(base).not.toBeNull();
        if (base === null) {
          continue;
        }
        for (const variant of fixture.variants) {
          const parsed = grammar.parse(variant);
          expect(parsed).not.toBeNull();
          if (parsed !== null) {
            expect(canonicalDecisionDocket(parsed)).toBe(
              canonicalDecisionDocket(base),
            );
          }
        }
      }
    });
  }
});
