import { describe, expect, test } from "bun:test";

import {
  addCents,
  applyMarkupCents,
  cents,
  currencyCents,
  MoneyTotals,
  prorateHourlyCents,
  unsafeCents,
} from ".";
import type { CentsAmount } from ".";

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
      prorateHourlyCents({
        billedMinutes: Number.parseFloat("1.5"),
        hourlyRateCents: cents(100),
      }),
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
    for (const bad of [
      Number.parseFloat("0.5"),
      -Number.parseFloat("0.0001"),
      Number.NaN,
      Infinity,
      -Infinity,
    ]) {
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
    for (let n = 0; n < 5000; n++) {
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
    for (let rc = 0; rc <= 2000; rc++) {
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
      billedMinutes: 6000,
      hourlyRateCents: cents(999_999),
    });
    const x = 6000 * 999_999;
    expect(r).toBe(cents(Math.floor((x + 30) / 60)));
    expect(Number.isSafeInteger(r)).toBe(true);
  });

  test("rejects non-integer or negative minutes", () => {
    expect(() =>
      prorateHourlyCents({ billedMinutes: -1, hourlyRateCents: cents(100) }),
    ).toThrow(TypeError);
    expect(() =>
      prorateHourlyCents({
        billedMinutes: Number.parseFloat("1.1"),
        hourlyRateCents: cents(100),
      }),
    ).toThrow(TypeError);
  });
});

describe("applyMarkupCents invariants", () => {
  test("IDENTITY: zero markup returns the amount unchanged", () => {
    const rand = makePrng(1_959_802);
    for (let n = 0; n < 1000; n++) {
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
    for (let n = 0; n < 5000; n++) {
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
      applyMarkupCents({
        amountCents: cents(100),
        markupPercent: Number.parseFloat("1.5"),
      }),
    ).toThrow(TypeError);
    expect(() =>
      applyMarkupCents({ amountCents: cents(100), markupPercent: Infinity }),
    ).toThrow(TypeError);
  });
});

describe("currencyCents() and addCents()", () => {
  test("currencyCents mints a CentsAmount-compatible value", () => {
    expect(currencyCents("USD", 1234)).toBe(currencyCents("USD", 1234));
  });

  test("currencyCents rejects an empty currency code", () => {
    expect(() => currencyCents("", 100)).toThrow(TypeError);
  });

  test("addCents sums two amounts of the same currency", () => {
    const a = currencyCents("USD", 150);
    const b = currencyCents("USD", 275);
    expect(addCents(a, b)).toBe(currencyCents("USD", 425));
  });

  test("addCents rejects a bad minor-unit amount at construction", () => {
    expect(() => currencyCents("USD", 1.5)).toThrow(TypeError);
  });

  test("COMPILE ERROR: addCents rejects mismatched currencies", () => {
    const usd = currencyCents("USD", 100);
    const eur = currencyCents("EUR", 100);
    // @ts-expect-error - addCents must not accept two different currencies
    addCents(usd, eur);
  });

  test("INVARIANT: addCents is commutative and associative", () => {
    const rand = makePrng(4_611_812);
    for (let n = 0; n < 2000; n++) {
      const x = currencyCents("USD", Math.floor(rand() * 1_000_000));
      const y = currencyCents("USD", Math.floor(rand() * 1_000_000));
      const z = currencyCents("USD", Math.floor(rand() * 1_000_000));
      expect(addCents(x, y)).toBe(addCents(y, x));
      expect(addCents(addCents(x, y), z)).toBe(addCents(x, addCents(y, z)));
    }
  });
});

describe("MoneyTotals", () => {
  test("groups amounts by currency", () => {
    const totals = new MoneyTotals();
    totals.add("USD", cents(100));
    totals.add("EUR", cents(200));
    totals.add("USD", cents(50));

    expect(totals.entries()).toEqual([
      { currency: "EUR", amountCents: cents(200) },
      { currency: "USD", amountCents: cents(150) },
    ]);
  });

  test("entries() is sorted deterministically by currency code", () => {
    const totals = new MoneyTotals();
    totals.add("USD", cents(1));
    totals.add("CZK", cents(1));
    totals.add("EUR", cents(1));
    totals.add("AUD", cents(1));

    expect(totals.entries().map((e) => e.currency)).toEqual([
      "AUD",
      "CZK",
      "EUR",
      "USD",
    ]);
  });

  test("an empty accumulator has no entries", () => {
    expect(new MoneyTotals().entries()).toEqual([]);
  });

  test("INVARIANT: entries() total per currency equals the sum of that currency's rows, regardless of insertion order", () => {
    const rand = makePrng(7_310_552);
    const currencies = ["USD", "EUR", "CZK", "GBP"];

    for (let trial = 0; trial < 200; trial++) {
      const rows: { currency: string; amount: number }[] = [];
      const rowCount = Math.floor(rand() * 40);
      for (let i = 0; i < rowCount; i++) {
        rows.push({
          currency: pickCurrency(currencies, rand),
          amount: Math.floor(rand() * 10_000),
        });
      }

      const expected = new Map<string, CentsAmount>();
      for (const row of rows) {
        expected.set(
          row.currency,
          cents((expected.get(row.currency) ?? 0) + row.amount),
        );
      }

      // Two independent random permutations of the same rows must produce
      // identical totals: MoneyTotals must be permutation-invariant.
      const shuffled = shuffle(rows, rand);
      const totals = new MoneyTotals();
      for (const row of shuffled) {
        totals.add(row.currency, cents(row.amount));
      }

      const actual = new Map(
        totals.entries().map((e) => [e.currency, e.amountCents]),
      );
      expect(actual.size).toBe(expected.size);
      for (const [currency, sum] of expected) {
        expect(actual.get(currency)).toBe(sum);
      }

      // entries() itself is always sorted, independent of insertion order.
      const currenciesOut = totals.entries().map((e) => e.currency);
      expect(currenciesOut).toEqual([...currenciesOut].sort());
    }
  });
});

function pickCurrency(
  currencies: readonly string[],
  rand: () => number,
): string {
  const currency = currencies.at(Math.floor(rand() * currencies.length));
  if (currency === undefined) {
    throw new Error("pickCurrency: index out of bounds");
  }
  return currency;
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const itemAtI = at(result, i);
    result[i] = at(result, j);
    result[j] = itemAtI;
  }
  return result;
}

function at<T>(items: readonly T[], index: number): T {
  const value = items.at(index);
  if (value === undefined) {
    throw new Error(`at: index ${index} out of bounds`);
  }
  return value;
}
