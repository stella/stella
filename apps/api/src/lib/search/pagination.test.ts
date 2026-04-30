import { describe, expect, test } from "bun:test";

import { encodeCursor } from "@/api/lib/search/cursor";
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
