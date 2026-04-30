import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/handlers/entities/window-cursor";

describe("entities window cursor", () => {
  test("round-trips the next offset", () => {
    const cursor = encodeEntitiesWindowCursor(400);
    const decoded = decodeEntitiesWindowCursor(cursor);

    expect(Result.isOk(decoded)).toBe(true);
    if (Result.isOk(decoded)) {
      expect(decoded.value).toBe(400);
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
