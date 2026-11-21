import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { chunk } from "./chunk";

describe("array partitioning", () => {
  test("returns no batches for no items", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  test("keeps every item once, in order, with only the last batch short", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("rejects a size that could not advance the cursor", () => {
    for (const size of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => chunk([1], size)).toThrow(
        "Chunk size must be a positive safe integer",
      );
    }
  });
});

test("chunk preserves every item and bounds every batch", () => {
  assertProperty(
    "chunk preserves every item and bounds every batch",
    fc.property(
      fc.array(fc.oneof(fc.integer(), fc.constant(undefined)), {
        maxLength: 1000,
      }),
      fc.integer({ min: 1, max: 100 }),
      (items, size) => {
        const before = [...items];
        const batches = chunk(items, size);
        expect(batches.flat()).toEqual(items);
        expect(items).toEqual(before);
        expect(batches).toHaveLength(Math.ceil(items.length / size));
        for (const [index, batch] of batches.entries()) {
          expect(batch.length).toBeGreaterThan(0);
          expect(batch.length).toBeLessThanOrEqual(size);
          if (index < batches.length - 1) {
            expect(batch).toHaveLength(size);
          }
        }
      },
    ),
  );
});
