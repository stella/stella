import { describe, expect, test } from "bun:test";

import { sha256Base64Url as legacyBase64Url } from "@stll/sha256/node";

import { decodePaginationCursor } from "@/api/lib/pagination";

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

for (const search of ["", "abc", "Žluťoučký kůň 📄", "e\u0301"]) {
  test(`actor cursor search scope retains legacy base64url bytes: ${JSON.stringify(search)}`, () => {
    const actorId = "4c39da33-7731-4b67-aab8-64ae821e46b4";
    expect(decodePaginationCursor(encodeActorCursor(search, actorId))).toEqual([
      legacyBase64Url(search),
      actorId,
    ]);
  });
}
