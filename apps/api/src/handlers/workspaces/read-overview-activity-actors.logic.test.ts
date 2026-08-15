import { describe, expect, test } from "bun:test";

import {
  decodeActorCursor,
  encodeActorCursor,
} from "./read-overview-activity-actors.logic";

describe("activity actor cursors", () => {
  test("binds a fixed-size cursor to the complete search", () => {
    const search = "\u{10ffff}".repeat(256);
    const actorId = "4c39da33-7731-4b67-aab8-64ae821e46b4";
    const cursor = encodeActorCursor(search, actorId);

    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(decodeActorCursor(cursor, search)).toBe(actorId);
    expect(decodeActorCursor(cursor, `${search}x`)).toBeNull();
  });
});
