import { describe, expect, test } from "bun:test";

import { applyMarkupCents, prorateHourlyCents } from ".";

describe("minor-unit billing arithmetic", () => {
  test("rounds prorated hourly rates without floating point cent drift", () => {
    expect(
      prorateHourlyCents({ billedMinutes: 11, hourlyRateCents: 150 }),
    ).toBe(28);
    expect(
      prorateHourlyCents({ billedMinutes: 11, hourlyRateCents: 330 }),
    ).toBe(61);
  });

  test("rounds expense markup without floating point cent drift", () => {
    expect(applyMarkupCents({ amountCents: 25, markupPercent: 82 })).toBe(46);
    expect(applyMarkupCents({ amountCents: 50, markupPercent: 13 })).toBe(57);
  });

  test("rejects invalid billing inputs", () => {
    expect(() =>
      prorateHourlyCents({ billedMinutes: 1.5, hourlyRateCents: 100 }),
    ).toThrow(TypeError);
    expect(() =>
      applyMarkupCents({ amountCents: 100, markupPercent: -1 }),
    ).toThrow(TypeError);
  });
});
