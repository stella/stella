import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  decodeEntitiesWindowCursor,
  ENTITY_SORTABLE_FIELD_VALUE_MAX_LENGTH,
  ENTITIES_WINDOW_CURSOR_MAX_LENGTH,
  encodeEntitiesWindowCursor,
} from "@/api/lib/entities/window-cursor";
import { LIMITS } from "@/api/lib/limits";

describe("entities window cursor", () => {
  test("round-trips sort tuple values", () => {
    const cursor = encodeEntitiesWindowCursor([
      "2026-01-01T00:00:00.000Z",
      "entity_1",
    ]);
    const decoded = decodeEntitiesWindowCursor(cursor);

    expect(Result.isOk(decoded)).toBe(true);
    if (Result.isOk(decoded)) {
      expect(decoded.value).toEqual(["2026-01-01T00:00:00.000Z", "entity_1"]);
    }
  });

  test("round-trips long tuple values generated from user data", () => {
    const longName = "a".repeat(1000);
    const cursor = encodeEntitiesWindowCursor([longName, "entity_1"]);
    const decoded = decodeEntitiesWindowCursor(cursor);

    expect(cursor.length).toBeGreaterThan(512);
    expect(cursor.length).toBeLessThan(ENTITIES_WINDOW_CURSOR_MAX_LENGTH);
    expect(Result.isOk(decoded)).toBe(true);
    if (Result.isOk(decoded)) {
      expect(decoded.value).toEqual([longName, "entity_1"]);
    }
  });

  const worstCaseSortValues = (count: number) =>
    Array.from({ length: count }, () =>
      "\u0001".repeat(ENTITY_SORTABLE_FIELD_VALUE_MAX_LENGTH),
    );

  test("keeps the worst-case escaped sort tuple within its request bound", () => {
    const cursor = encodeEntitiesWindowCursor([
      ...worstCaseSortValues(LIMITS.viewSortsCount),
      "entity_1",
    ]);

    expect(cursor.length).toBeLessThan(ENTITIES_WINDOW_CURSOR_MAX_LENGTH);
  });

  // The budget is sized from viewSortsCount, not from the property cap: one
  // sort beyond the cap must overflow it, or the bound tracks nothing.
  test("does not fit one sort more than the sorts cap allows", () => {
    const cursor = encodeEntitiesWindowCursor([
      ...worstCaseSortValues(LIMITS.viewSortsCount + 1),
      "entity_1",
    ]);

    expect(cursor.length).toBeGreaterThan(ENTITIES_WINDOW_CURSOR_MAX_LENGTH);
  });

  test("rejects tampered cursor values", () => {
    const decoded = decodeEntitiesWindowCursor("not-json");

    expect(Result.isError(decoded)).toBe(true);
    if (Result.isError(decoded)) {
      expect(decoded.error.status).toBe(400);
    }
  });
});
