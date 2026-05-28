import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  GLOBAL_SEARCH_MAX_OFFSET,
  resolveGlobalSearchNextCursor,
} from "@/api/lib/search/pagination";

describe("global search pagination", () => {
  test("returns the next cursor while the next page is below the max offset", () => {
    expect(
      resolveGlobalSearchNextCursor({
        limit: 25,
        offset: 50,
        totalCount: 100,
        hitsLength: 25,
      }),
    ).toBe(encodeCursor(75, "global"));
  });

  test("does not return a cursor at or beyond the max offset", () => {
    expect(
      resolveGlobalSearchNextCursor({
        limit: 25,
        offset: GLOBAL_SEARCH_MAX_OFFSET - 25,
        totalCount: GLOBAL_SEARCH_MAX_OFFSET + 100,
        hitsLength: 25,
      }),
    ).toBeNull();
  });

  test("stops paginating when the page is short", () => {
    expect(
      resolveGlobalSearchNextCursor({
        limit: 25,
        offset: 50,
        totalCount: 100,
        hitsLength: 10,
      }),
    ).toBeNull();
  });

  test("falls back to hits length when totalCount is unknown (paginated request)", () => {
    expect(
      resolveGlobalSearchNextCursor({
        limit: 25,
        offset: 50,
        totalCount: null,
        hitsLength: 25,
      }),
    ).toBe(encodeCursor(75, "global"));

    expect(
      resolveGlobalSearchNextCursor({
        limit: 25,
        offset: 50,
        totalCount: null,
        hitsLength: 5,
      }),
    ).toBeNull();
  });

  test("refuses to advance past a known total", () => {
    expect(
      resolveGlobalSearchNextCursor({
        limit: 25,
        offset: 50,
        totalCount: 75,
        hitsLength: 25,
      }),
    ).toBeNull();
  });
});

describe("global search pagination — properties", () => {
  const arbLimit = fc.integer({ min: 1, max: 100 });
  const arbOffset = fc.integer({
    min: 0,
    max: GLOBAL_SEARCH_MAX_OFFSET + 200,
  });
  const arbHitsLength = fc.integer({ min: 0, max: 100 });
  const arbTotalCount = fc.option(fc.integer({ min: 0, max: 5000 }), {
    nil: null,
  });

  test("returns null iff any pruning rule fires; otherwise encodes nextOffset", () => {
    fc.assert(
      fc.property(
        arbLimit,
        arbOffset,
        arbHitsLength,
        arbTotalCount,
        (limit, offset, hitsLength, totalCount) => {
          const result = resolveGlobalSearchNextCursor({
            limit,
            offset,
            totalCount,
            hitsLength,
          });
          const nextOffset = offset + limit;
          const shouldStop =
            nextOffset >= GLOBAL_SEARCH_MAX_OFFSET ||
            hitsLength < limit ||
            (totalCount !== null && totalCount <= nextOffset);

          if (shouldStop) {
            expect(result).toBeNull();
          } else {
            expect(result).toBe(encodeCursor(nextOffset, "global"));
          }
        },
      ),
    );
  });

  test("non-null cursor decodes to (nextOffset, 'global')", () => {
    fc.assert(
      fc.property(
        arbLimit,
        arbOffset,
        arbHitsLength,
        arbTotalCount,
        (limit, offset, hitsLength, totalCount) => {
          const result = resolveGlobalSearchNextCursor({
            limit,
            offset,
            totalCount,
            hitsLength,
          });
          if (result === null) {
            return;
          }
          expect(decodeCursor(result)).toEqual({
            score: offset + limit,
            id: "global",
          });
        },
      ),
    );
  });
});
