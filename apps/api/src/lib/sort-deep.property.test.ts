import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { sortDeep } from "@/api/lib/sort-deep";

// A JSON-shaped value: the canonicalizer is used to stabilize JSONB before
// hashing/diffing. Keys exclude "__proto__" so the generator never builds a
// value whose own key collides with the prototype (sortDeep itself defends
// against this via Object.defineProperty; the generator just avoids muddying
// the structural equality checks below).
const jsonValue = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 4, depthSize: "small" },
    fc.oneof(
      fc.string(),
      fc.integer(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.boolean(),
      fc.constant(null),
    ),
    fc.array(tie("value"), { maxLength: 5 }),
    fc.dictionary(
      fc.string().filter((key) => key !== "__proto__"),
      tie("value"),
      { maxKeys: 5 },
    ),
  ),
})).value;

// Rebuild `value` with every object's keys reinserted in reverse order. Two
// structurally-equal values that differ only in key insertion order must
// canonicalize to byte-identical JSON — that is the property that makes
// sortDeep usable as a stable hash/diff key. (A plain "keys are lexicographic
// at every depth" check would be wrong: JS always enumerates integer-like keys
// first, so sortDeep cannot fully reorder a mix of "0" and "a".)
const reverseKeyOrder = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(reverseKeyOrder);
  }
  if (typeof value === "object" && value !== null) {
    const rebuilt: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).toReversed()) {
      rebuilt[key] = reverseKeyOrder(child);
    }
    return rebuilt;
  }
  return value;
};

describe("sortDeep (properties)", () => {
  test("preserves the logical value (only key order changes)", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        // `toEqual` ignores key order, so equality here means no data was
        // added, dropped, or mutated.
        expect(sortDeep(value)).toEqual(value);
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("canonicalizes independently of input key order", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(JSON.stringify(sortDeep(value))).toBe(
          JSON.stringify(sortDeep(reverseKeyOrder(value))),
        );
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const once = sortDeep(value);
        expect(sortDeep(once)).toEqual(once);
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });
});
