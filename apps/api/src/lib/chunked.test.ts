import { describe, expect, test } from "bun:test";

import { chunked } from "@/api/lib/chunked";

describe("chunked", () => {
  test("returns no batches for no items", () => {
    expect(chunked([], 3)).toEqual([]);
  });

  test("keeps every item once, in order, with only the last batch short", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("rejects a size that could not advance the cursor", () => {
    for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => chunked([1], size)).toThrow(
        "Chunk size must be a positive safe integer",
      );
    }
  });
});
