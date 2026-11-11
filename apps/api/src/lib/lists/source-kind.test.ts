import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  DEFAULT_SOURCE_KIND,
  FACT_TIERS,
  factTier,
  SOURCE_KINDS,
  sourceKindOrDefault,
} from "@/api/lib/lists/source-kind";

const kindsArbitrary = fc.array(fc.constantFrom(...SOURCE_KINDS), {
  maxLength: 8,
});

describe("factTier", () => {
  test("a fact's tier is the best kind among its sources, unsourced without one", () => {
    assertProperty(
      "a fact's tier is the best kind among its sources, unsourced without one",
      fc.property(kindsArbitrary, (kinds) => {
        const tier = factTier(kinds);
        if (kinds.length === 0) {
          expect(tier).toBe("unsourced");
          return;
        }
        // The tier is one of the kinds cited, and no cited kind ranks
        // above it.
        expect(kinds.some((kind) => kind === tier)).toBe(true);
        for (const kind of kinds) {
          expect(FACT_TIERS.indexOf(tier)).toBeLessThanOrEqual(
            FACT_TIERS.indexOf(kind),
          );
        }
      }),
    );
  });

  test("the sources count as a set: order and repeats change nothing", () => {
    assertProperty(
      "the sources count as a set: order and repeats change nothing",
      fc.property(kindsArbitrary, kindsArbitrary, (kinds, more) => {
        expect(factTier(kinds.toReversed())).toBe(factTier(kinds));
        expect(factTier([...kinds, ...kinds])).toBe(factTier(kinds));
        expect(factTier([...new Set(kinds)])).toBe(factTier(kinds));
        // Adding a source never lowers a fact's footing.
        expect(
          FACT_TIERS.indexOf(factTier([...kinds, ...more])),
        ).toBeLessThanOrEqual(FACT_TIERS.indexOf(factTier(kinds)));
      }),
    );
  });

  test("one document record lifts a fact out of testimony", () => {
    expect(factTier(["testimony", "testimony"])).toBe("testimony");
    expect(factTier(["testimony", "document"])).toBe("document");
  });
});

describe("sourceKindOrDefault", () => {
  test("an unclassified document is a record; a classified one keeps its kind", () => {
    expect(DEFAULT_SOURCE_KIND).toBe("document");
    expect(sourceKindOrDefault(null)).toBe("document");
    for (const kind of SOURCE_KINDS) {
      expect(sourceKindOrDefault(kind)).toBe(kind);
    }
  });
});
