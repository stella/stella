import { describe, expect, test } from "bun:test";

import { applyMarkupCents, cents, prorateHourlyCents, unsafeCents } from ".";

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

// Deterministic LCG so a fuzz failure is reproducible, never flaky.
const LCG_MODULUS = 2 ** 32;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;

const makePrng = (seed: number) => {
  let state = Math.trunc(seed) % LCG_MODULUS;
  if (state < 0) {
    state += LCG_MODULUS;
  }
  return () => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return state / LCG_MODULUS;
  };
};

describe("cents() brand constructor", () => {
  test("accepts integer-valued floats and zero", () => {
    expect(cents(0)).toBe(cents(0));
    expect(cents(Number.parseFloat("2.0"))).toBe(cents(2));
  });

  test("rejects non-integer, NaN and infinite inputs", () => {
    for (const bad of [0.5, -0.0001, Number.NaN, Infinity, -Infinity]) {
      expect(() => cents(bad)).toThrow(TypeError);
    }
  });

  test("unsafeCents is a pure brand attach with no rounding", () => {
    // Documented escape hatch: it must not silently coerce; the value
    // passes through verbatim (callers assert validity themselves).
    expect(unsafeCents(1234)).toBe(cents(1234));
  });
});

describe("prorateHourlyCents invariants", () => {
  test("zero minutes or zero rate yields zero", () => {
    expect(
      prorateHourlyCents({ billedMinutes: 0, hourlyRateCents: cents(500) }),
    ).toBe(cents(0));
    expect(
      prorateHourlyCents({ billedMinutes: 90, hourlyRateCents: cents(0) }),
    ).toBe(cents(0));
  });

  test("rounds an exact half-cent UP (round-half-up, not banker's)", () => {
    // minutes * rate === 30 ==> exact 0.5 cents ==> must round to 1.
    expect(
      prorateHourlyCents({ billedMinutes: 1, hourlyRateCents: cents(30) }),
    ).toBe(cents(1));
    // minutes * rate === 90 ==> exact 1.5 cents ==> must round to 2.
    expect(
      prorateHourlyCents({ billedMinutes: 1, hourlyRateCents: cents(90) }),
    ).toBe(cents(2));
    // Just below the half (29/60 = 0.483) must round down to 0.
    expect(
      prorateHourlyCents({ billedMinutes: 1, hourlyRateCents: cents(29) }),
    ).toBe(cents(0));
  });

  test("INVARIANT: result is the exact round-half-up of (minutes*rate)/60", () => {
    const rand = makePrng(6_220_033);
    for (let n = 0; n < 5_000; n++) {
      const billedMinutes = Math.floor(rand() * 600); // up to 10h
      const rate = Math.floor(rand() * 500_000); // up to $5000/h
      const r = prorateHourlyCents({
        billedMinutes,
        hourlyRateCents: cents(rate),
      });
      const x = billedMinutes * rate;
      // floor((x+30)/60) === r  <=>  60r-30 <= x < 60r+30
      const d = x - 60 * r;
      expect(d).toBeGreaterThanOrEqual(-30);
      expect(d).toBeLessThan(30);
      expect(Number.isInteger(r)).toBe(true);
    }
  });

  test("INVARIANT: non-decreasing in minutes and in rate", () => {
    const rate = cents(317);
    let prev = -1;
    for (let m = 0; m <= 480; m++) {
      const v = prorateHourlyCents({ billedMinutes: m, hourlyRateCents: rate });
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    const minutes = 137;
    prev = -1;
    for (let rc = 0; rc <= 2_000; rc++) {
      const v = prorateHourlyCents({
        billedMinutes: minutes,
        hourlyRateCents: cents(rc),
      });
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test("stays exact for large but realistic invoices (no float drift)", () => {
    // 100h at $9,999.99/h: product is ~6e9, well under MAX_SAFE_INTEGER.
    const r = prorateHourlyCents({
      billedMinutes: 6_000,
      hourlyRateCents: cents(999_999),
    });
    const x = 6_000 * 999_999;
    expect(r).toBe(cents(Math.floor((x + 30) / 60)));
    expect(Number.isSafeInteger(r)).toBe(true);
  });

  test("rejects non-integer or negative minutes", () => {
    expect(() =>
      prorateHourlyCents({ billedMinutes: -1, hourlyRateCents: cents(100) }),
    ).toThrow(TypeError);
    expect(() =>
      prorateHourlyCents({ billedMinutes: 1.1, hourlyRateCents: cents(100) }),
    ).toThrow(TypeError);
  });
});

describe("applyMarkupCents invariants", () => {
  test("IDENTITY: zero markup returns the amount unchanged", () => {
    const rand = makePrng(1_959_802);
    for (let n = 0; n < 1_000; n++) {
      const amount = Math.floor(rand() * 1_000_000);
      expect(
        applyMarkupCents({ amountCents: cents(amount), markupPercent: 0 }),
      ).toBe(cents(amount));
    }
  });

  test("rounds an exact half-cent UP", () => {
    // 1 cent + 50% = 1.5 ==> 2.
    expect(applyMarkupCents({ amountCents: cents(1), markupPercent: 50 })).toBe(
      cents(2),
    );
    // 2 cents + 25% = 2.5 ==> 3.
    expect(applyMarkupCents({ amountCents: cents(2), markupPercent: 25 })).toBe(
      cents(3),
    );
  });

  test("INVARIANT: result is the exact round-half-up of amount*(100+markup)/100", () => {
    const rand = makePrng(6_220_034);
    for (let n = 0; n < 5_000; n++) {
      const amount = Math.floor(rand() * 500_000);
      const markup = Math.floor(rand() * 300); // up to +300%
      const r = applyMarkupCents({
        amountCents: cents(amount),
        markupPercent: markup,
      });
      const p = amount * (100 + markup);
      const d = p - 100 * r;
      expect(d).toBeGreaterThanOrEqual(-50);
      expect(d).toBeLessThan(50);
    }
  });

  test("INVARIANT: non-decreasing in markup and never below the base amount", () => {
    const amount = cents(733);
    let prev = -1;
    for (let mk = 0; mk <= 500; mk++) {
      const v = applyMarkupCents({ amountCents: amount, markupPercent: mk });
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(amount);
      prev = v;
    }
  });

  test("rejects negative or non-integer inputs", () => {
    expect(() =>
      applyMarkupCents({ amountCents: cents(100), markupPercent: 1.5 }),
    ).toThrow(TypeError);
    expect(() =>
      applyMarkupCents({ amountCents: cents(100), markupPercent: Infinity }),
    ).toThrow(TypeError);
  });
});
