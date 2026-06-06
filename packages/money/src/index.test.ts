import { describe, expect, test } from "bun:test";

import { applyMarkupCents, cents, prorateHourlyCents } from ".";

describe("minor-unit billing arithmetic", () => {
  test("rounds prorated hourly rates without floating point cent drift", () => {
    expect(
      prorateHourlyCents({ billedMinutes: 11, hourlyRateCents: cents(150) }),
    ).toBe(cents(28));
    expect(
      prorateHourlyCents({ billedMinutes: 11, hourlyRateCents: cents(330) }),
    ).toBe(cents(61));
  });

  test("rounds expense markup without floating point cent drift", () => {
    expect(
      applyMarkupCents({ amountCents: cents(25), markupPercent: 82 }),
    ).toBe(cents(46));
    expect(
      applyMarkupCents({ amountCents: cents(50), markupPercent: 13 }),
    ).toBe(cents(57));
  });

  test("rejects invalid billing inputs", () => {
    expect(() =>
      prorateHourlyCents({ billedMinutes: 1.5, hourlyRateCents: cents(100) }),
    ).toThrow(TypeError);
    expect(() =>
      applyMarkupCents({ amountCents: cents(100), markupPercent: -1 }),
    ).toThrow(TypeError);
  });
});
