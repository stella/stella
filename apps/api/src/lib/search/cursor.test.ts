import { describe, expect, test } from "bun:test";

import { decodeCursor, encodeCursor } from "./cursor";

describe("search cursor encoding", () => {
  test("roundtrips finite score and id tuples", () => {
    const cursor = encodeCursor(0.875, "ent_123");

    expect(decodeCursor(cursor)).toEqual({
      score: 0.875,
      id: "ent_123",
    });
  });

  test("rejects malformed cursors", () => {
    const malformed = Buffer.from("not-a-number:ent_123").toString("base64");
    const missingId = Buffer.from("0.5:").toString("base64");
    const infiniteScore = Buffer.from("Infinity:ent_123").toString("base64");

    expect(decodeCursor("not base64")).toBeNull();
    expect(decodeCursor(malformed)).toBeNull();
    expect(decodeCursor(missingId)).toBeNull();
    expect(decodeCursor(infiniteScore)).toBeNull();
  });
});
