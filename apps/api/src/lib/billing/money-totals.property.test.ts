import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { cents, MoneyTotals, prorateHourlyCents } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

const CURRENCIES = ["CZK", "EUR", "GBP", "PLN", "USD"] as const;

const entryArb = fc.record({
  currency: fc.constantFrom(...CURRENCIES),
  amount: fc.integer({ min: 0, max: 10_000_000 }),
});

describe("multi-currency MoneyTotals and hourly proration properties", () => {
  test("MoneyTotals is permutation-invariant, currency-isolated, and deterministically sorted", () => {
    assertProperty(
      "MoneyTotals is permutation-invariant, currency-isolated, and deterministically sorted",
      fc.property(
        fc.array(entryArb, { minLength: 0, maxLength: 30 }),
        (items) => {
          const forward = new MoneyTotals();
          const reversed = new MoneyTotals();
          const expected = new Map<string, number>();

          for (const item of items) {
            forward.add(item.currency, cents(item.amount));
            expected.set(
              item.currency,
              (expected.get(item.currency) ?? 0) + item.amount,
            );
          }
          for (const item of [...items].toReversed()) {
            reversed.add(item.currency, cents(item.amount));
          }

          const forwardEntries = forward.entries();
          expect(reversed.entries()).toEqual(forwardEntries);
          expect(forwardEntries.length).toBe(expected.size);

          let prevCurrency: string | undefined;
          for (const entry of forwardEntries) {
            if (prevCurrency !== undefined) {
              expect(prevCurrency < entry.currency).toBe(true);
            }
            prevCurrency = entry.currency;
            expect(entry.amountCents).toBe(
              cents(expected.get(entry.currency) ?? 0),
            );
          }
        },
      ),
    );
  });

  test("prorateHourlyCents is exact on whole hours, monotonic, and bounded within 1 cent on splits", () => {
    assertProperty(
      "prorateHourlyCents is exact on whole hours, monotonic, and bounded within 1 cent on splits",
      fc.property(
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (m1, m2, hourlyRate) => {
          const rate = cents(hourlyRate);
          expect(
            prorateHourlyCents({ billedMinutes: 0, hourlyRateCents: rate }),
          ).toBe(cents(0));
          expect(
            prorateHourlyCents({
              billedMinutes: m1,
              hourlyRateCents: cents(0),
            }),
          ).toBe(cents(0));
          const wholeHours = Math.min(m1, 100);
          expect(
            prorateHourlyCents({
              billedMinutes: wholeHours * 60,
              hourlyRateCents: rate,
            }),
          ).toBe(cents(wholeHours * hourlyRate));

          const a = prorateHourlyCents({
            billedMinutes: m1,
            hourlyRateCents: rate,
          });
          const b = prorateHourlyCents({
            billedMinutes: m2,
            hourlyRateCents: rate,
          });
          const combined = prorateHourlyCents({
            billedMinutes: m1 + m2,
            hourlyRateCents: rate,
          });
          expect(combined).toBeGreaterThanOrEqual(a);
          expect(combined).toBeGreaterThanOrEqual(b);
          expect(Math.abs(combined - (a + b))).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});
