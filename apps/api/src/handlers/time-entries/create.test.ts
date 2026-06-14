import { describe, expect, test } from "bun:test";

import { roundToIncrement } from "./create";

describe("roundToIncrement (billing increment snap)", () => {
  test("ceils to the 6-minute billing increment", () => {
    expect(roundToIncrement(0)).toBe(0);
    expect(roundToIncrement(1)).toBe(6);
    expect(roundToIncrement(6)).toBe(6);
    expect(roundToIncrement(7)).toBe(12);
    expect(roundToIncrement(12)).toBe(12);
    expect(roundToIncrement(13)).toBe(18);
  });

  test("INVARIANT: result is a multiple of 6, >= input, < input + 6", () => {
    for (let m = 0; m <= 600; m++) {
      const r = roundToIncrement(m);
      expect(r % 6).toBe(0);
      expect(r).toBeGreaterThanOrEqual(m);
      expect(r).toBeLessThan(m + 6);
    }
  });
});
