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
      }),
    ).toBe(encodeCursor(75, "global"));
  });

  test("does not return a cursor at or beyond the max offset", () => {
    expect(
      resolveGlobalSearchNextCursor({
        limit: 25,
        offset: GLOBAL_SEARCH_MAX_OFFSET - 25,
        totalCount: GLOBAL_SEARCH_MAX_OFFSET + 100,
      }),
    ).toBeNull();
  });
});
