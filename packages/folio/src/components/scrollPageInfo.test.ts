import { describe, expect, test } from "bun:test";

import { updateScrollPageTotal } from "./scrollPageInfo";

describe("scroll page info", () => {
  test("clamps current page when the document shrinks", () => {
    expect(
      updateScrollPageTotal(
        { currentPage: 10, totalPages: 10, visible: true },
        3,
      ),
    ).toEqual({ currentPage: 3, totalPages: 3, visible: true });
  });

  test("preserves current page when it remains in range", () => {
    expect(
      updateScrollPageTotal(
        { currentPage: 2, totalPages: 5, visible: true },
        4,
      ),
    ).toEqual({ currentPage: 2, totalPages: 4, visible: true });
  });
});
