import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/handlers/entities/window-cursor";

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
    expect(Result.isOk(decoded)).toBe(true);
    if (Result.isOk(decoded)) {
      expect(decoded.value).toEqual([longName, "entity_1"]);
    }
  });

  test("rejects tampered cursor values", () => {
    const decoded = decodeEntitiesWindowCursor("not-json");

    expect(Result.isError(decoded)).toBe(true);
    if (Result.isError(decoded)) {
      expect(decoded.error.status).toBe(400);
    }
  });
});
