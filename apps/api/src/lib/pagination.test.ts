import { describe, expect, test } from "bun:test";

import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

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

  test("roundtrips opaque cursor parts", () => {
    const cursor = encodePaginationCursor([
      "2026-05-16T10:30:00.000Z",
      "invoice_123",
      7,
    ]);

    expect(decodePaginationCursor(cursor)).toEqual([
      "2026-05-16T10:30:00.000Z",
      "invoice_123",
      7,
    ]);
  });

  test("rejects malformed cursors", () => {
    expect(decodePaginationCursor("not-json")).toBeNull();
    expect(decodePaginationCursor(encodePaginationCursor(["valid"]))).toEqual([
      "valid",
    ]);
  });
});
