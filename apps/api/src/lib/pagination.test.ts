import { describe, expect, test } from "bun:test";

import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
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

  test("validates date-only cursor parts", () => {
    expect(isDateOnlyPaginationCursorPart("2026-05-16")).toBe(true);
    expect(isDateOnlyPaginationCursorPart("2026-02-30")).toBe(false);
    expect(isDateOnlyPaginationCursorPart("2026-99-99")).toBe(false);
    expect(isDateOnlyPaginationCursorPart("2026-5-16")).toBe(false);
  });

  test("validates UUID cursor parts", () => {
    expect(
      isUuidPaginationCursorPart("018f3d26-388b-7b90-9e39-86c58be5f97a"),
    ).toBe(true);
    expect(isUuidPaginationCursorPart("not-a-uuid")).toBe(false);
    expect(isUuidPaginationCursorPart("invoice_123")).toBe(false);
  });

  test("parses canonical ISO datetime cursor parts", () => {
    expect(
      parseDateTimePaginationCursorPart("2026-05-16T10:30:00.000Z"),
    ).toEqual(new Date("2026-05-16T10:30:00.000Z"));
    expect(parseDateTimePaginationCursorPart("2026-99-99")).toBeNull();
    expect(
      parseDateTimePaginationCursorPart("2026-05-16T10:30:00Z"),
    ).toBeNull();
  });
});
