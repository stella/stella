import { describe, expect, test } from "bun:test";

import { createCursorPage } from "@/api/lib/pagination";

describe("cursor pagination", () => {
  test("returns the requested window and a cursor when another row exists", () => {
    const page = createCursorPage({
      rows: [{ id: "one" }, { id: "two" }, { id: "three" }],
      limit: 2,
      cursorForItem: (item) => item.id,
    });

    expect(page).toEqual({
      items: [{ id: "one" }, { id: "two" }],
      limit: 2,
      nextCursor: "two",
    });
  });

  test("returns a null cursor on the last page", () => {
    const page = createCursorPage({
      rows: [{ id: "one" }, { id: "two" }],
      limit: 2,
      cursorForItem: (item) => item.id,
    });

    expect(page).toEqual({
      items: [{ id: "one" }, { id: "two" }],
      limit: 2,
      nextCursor: null,
    });
  });
});
