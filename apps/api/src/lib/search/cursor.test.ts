import { describe, expect, test } from "bun:test";
import fc from "fast-check";

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

describe("search cursor encoding — properties", () => {
  // The decoder splits on ":" and takes only the first two parts, so ids containing ":"
  // cannot round-trip. -0 is excluded because String(-0) === "0" loses the sign.
  const arbId = fc
    .string({ minLength: 1, maxLength: 32 })
    .filter((s) => !s.includes(":"));
  const arbScore = fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Object.is(n, -0));

  test("encode → decode round-trips finite score + id pairs", () => {
    fc.assert(
      fc.property(arbScore, arbId, (score, id) => {
        expect(decodeCursor(encodeCursor(score, id))).toEqual({ score, id });
      }),
    );
  });

  test("decode is total — never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = decodeCursor(input);
        const ok =
          result === null ||
          (Number.isFinite(result.score) &&
            typeof result.id === "string" &&
            result.id.length > 0);
        expect(ok).toBe(true);
      }),
    );
  });
});
