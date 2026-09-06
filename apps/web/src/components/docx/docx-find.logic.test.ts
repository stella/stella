import { describe, expect, test } from "bun:test";

import { resetOpenDocxFindQuery } from "./docx-find.logic";

describe("resetOpenDocxFindQuery", () => {
  test("invalidates stale navigation state before the new search runs", () => {
    const state = resetOpenDocxFindQuery(
      {
        status: "open",
        activeIndex: 2,
        focusSeq: 4,
        query: "old query",
        summary: { count: 5, truncated: true },
      },
      "new query",
    );

    expect(state).toEqual({
      status: "open",
      activeIndex: 0,
      focusSeq: 4,
      query: "new query",
      summary: { count: 0, truncated: false },
    });
  });
});
