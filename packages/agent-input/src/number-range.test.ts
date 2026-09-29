import { describe, expect, test } from "bun:test";

import { normalizeNumberInRange } from "./number";

const PAGE_SIZE = { minimum: 1, maximum: 100, integer: true } as const;

describe("bounded counts", () => {
  test("a count above the most is clamped, with a note", () => {
    expect(normalizeNumberInRange(500, PAGE_SIZE)).toEqual({
      ok: true,
      value: 100,
      note: "Read 500 as 100, the most this accepts.",
    });
  });

  test("a count below the least is clamped, with a note", () => {
    expect(normalizeNumberInRange(0, PAGE_SIZE)).toEqual({
      ok: true,
      value: 1,
      note: "Read 0 as 1, the least this accepts.",
    });
  });

  test("the spelling note and the clamp note are both kept", () => {
    expect(normalizeNumberInRange("4 000", PAGE_SIZE)).toEqual({
      ok: true,
      value: 100,
      note: 'Read "4 000" as 4000. Read 4000 as 100, the most this accepts.',
    });
  });

  test("a spelled count in range keeps only its spelling note", () => {
    expect(normalizeNumberInRange("25", PAGE_SIZE)).toEqual({
      ok: true,
      value: 25,
      note: 'Read "25" as 25.',
    });
  });

  test("a fraction asks when the count is whole", () => {
    expect(normalizeNumberInRange(12.5, PAGE_SIZE)).toEqual({
      ok: false,
      received: "12.5",
      expected: "a whole number",
      hint: "Send a whole number from 1 to 100 as a JSON number.",
    });
    expect(normalizeNumberInRange(12.5, { maximum: 100 })).toEqual({
      ok: true,
      value: 12.5,
    });
  });

  test("a spelling the number reader asks about still asks", () => {
    expect(normalizeNumberInRange("1,234", PAGE_SIZE).ok).toBe(false);
  });
});
