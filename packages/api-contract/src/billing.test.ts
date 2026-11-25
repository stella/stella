import { describe, expect, test } from "bun:test";

import { roundToBillingIncrement } from "./billing";

describe("roundToBillingIncrement", () => {
  test("bills every commenced unit in full", () => {
    for (const unit of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]) {
      for (let minutes = 0; minutes <= 180; minutes++) {
        const billed = roundToBillingIncrement(minutes, unit);
        expect(billed % unit).toBe(0);
        expect(billed).toBeGreaterThanOrEqual(minutes);
        expect(billed).toBeLessThan(minutes + unit);
      }
    }
    expect(roundToBillingIncrement(7, 15)).toBe(15);
  });
});
