import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { sortDeep } from "./sort-deep";

/**
 * Property-based tests for sortDeep. Verifies invariants
 * that must hold for all JSON-compatible inputs: idempotency,
 * key ordering, value preservation, and structural stability.
 *
 * Note: ES engines order integer-index keys (e.g. "0", "1")
 * before string keys regardless of insertion order (spec
 * §10.1.12). sortDeep cannot override this; tests account
 * for it by comparing sorted output structurally rather than
 * asserting raw key order for objects with numeric keys.
 */

const jsonArbitrary = fc.jsonValue();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        normalizeJsonValue(entryValue),
      ]),
    );
  }

  return value;
};

describe("sortDeep", () => {
  test("idempotent: sorting twice yields the same result", () => {
    fc.assert(
      fc.property(jsonArbitrary, (input) => {
        const once = sortDeep(input);
        const twice = sortDeep(once);
        expect(twice).toEqual(once);
      }),
    );
  });

  test("preserves JSON serialisation roundtrip", () => {
    fc.assert(
      fc.property(jsonArbitrary, (input) => {
        const sorted = sortDeep(input);
        const serialised = JSON.stringify(sorted);
        // Re-serialise the parsed output; if sortDeep
        // introduced non-JSON-safe values, they'd differ.
        // Uses stringify comparison (not toEqual) because
        // JSON.stringify(-0) → "0" and toEqual uses Object.is.
        expect(JSON.stringify(JSON.parse(serialised))).toBe(serialised);
      }),
    );
  });

  test("non-index string keys are sorted ascending at every level", () => {
    const isIndex = (k: string) => /^(?:0|[1-9]\d*)$/.test(k);

    const assertKeysSorted = (v: unknown): void => {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        // Filter out integer-index keys; engines reorder
        // those per spec regardless of insertion order
        const stringKeys = Object.keys(v).filter((k) => !isIndex(k));
        const sorted = stringKeys.toSorted();
        expect(stringKeys).toEqual(sorted);
        for (const val of Object.values(v)) {
          assertKeysSorted(val);
        }
      }
      if (Array.isArray(v)) {
        for (const el of v) {
          assertKeysSorted(el);
        }
      }
    };

    fc.assert(
      fc.property(jsonArbitrary, (input) => {
        assertKeysSorted(sortDeep(input));
      }),
    );
  });

  test("sorting preserves all values (deep equality ignoring key order)", () => {
    fc.assert(
      fc.property(jsonArbitrary, (input) => {
        const sorted = sortDeep(input);
        // Rebuild objects from entries so prototype quirks
        // (for example "__proto__" keys) do not affect the
        // structural comparison.
        expect(normalizeJsonValue(sorted)).toEqual(normalizeJsonValue(input));
      }),
    );
  });

  test("preserves array element order", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.integer(), fc.string())), (arr) => {
        const sorted = sortDeep(arr);
        expect(sorted).toEqual(arr);
      }),
    );
  });

  test("primitives pass through unchanged", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.double({ noNaN: true }),
          fc.boolean(),
          fc.constant(null),
        ),
        (prim) => {
          expect(sortDeep(prim)).toBe(prim);
        },
      ),
    );
  });

  test("handles deeply nested structures", () => {
    const deep = { z: { y: { x: { w: { v: 1 } } } } };
    expect(sortDeep(deep)).toEqual(deep);
  });

  test("sorts keys in a flat object", () => {
    const result = sortDeep({ c: 3, a: 1, b: 2 });
    // JSON.stringify preserves insertion order, so this
    // verifies keys are in sorted order
    expect(JSON.stringify(result)).toBe('{"a":1,"b":2,"c":3}');
  });

  test("sorts keys in nested objects", () => {
    const input = { z: { b: 2, a: 1 }, a: { d: 4, c: 3 } };
    expect(JSON.stringify(sortDeep(input))).toBe(
      '{"a":{"c":3,"d":4},"z":{"a":1,"b":2}}',
    );
  });

  test("sorts objects inside arrays", () => {
    const input = [
      { b: 2, a: 1 },
      { d: 4, c: 3 },
    ];
    expect(JSON.stringify(sortDeep(input))).toBe(
      '[{"a":1,"b":2},{"c":3,"d":4}]',
    );
  });

  test("returns empty object as-is", () => {
    expect(sortDeep({})).toEqual({});
  });

  test("returns empty array as-is", () => {
    expect(sortDeep([])).toEqual([]);
  });

  test("preserves own __proto__ keys from parsed JSON objects", () => {
    const input: unknown = JSON.parse('{"__proto__":"","b":2,"a":1}');
    if (!isRecord(input)) {
      throw new Error("Expected parsed JSON object");
    }

    const result = sortDeep(input);
    if (!isRecord(result)) {
      throw new Error("Expected sorted object");
    }

    expect(Object.keys(result)).toEqual(["__proto__", "a", "b"]);
    expect(JSON.stringify(result)).toBe('{"__proto__":"","a":1,"b":2}');
  });
});
