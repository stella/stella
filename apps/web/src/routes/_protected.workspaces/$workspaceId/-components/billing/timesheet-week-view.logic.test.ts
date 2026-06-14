import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import {
  matterCurrencyMap,
  summarizeBillableAmountByCurrency,
  type TimesheetTotalEntry,
} from "./timesheet-week-view.logic";

const entry = (
  overrides: Partial<TimesheetTotalEntry> = {},
): TimesheetTotalEntry => ({
  matterId: "m1",
  currency: "USD",
  billable: true,
  billedMinutes: 60,
  rateAtEntry: cents(10_000),
  ...overrides,
});

describe("summarizeBillableAmountByCurrency", () => {
  test("sums a single-currency week into one subtotal", () => {
    const totals = summarizeBillableAmountByCurrency([entry(), entry()]);
    expect(totals).toEqual([{ currency: "USD", amount: 20_000 }]);
  });

  test("keeps mixed currencies as separate subtotals, never summed together", () => {
    const totals = summarizeBillableAmountByCurrency([
      entry({ currency: "USD" }),
      entry({ currency: "EUR", rateAtEntry: cents(20_000) }),
    ]);
    // Sorted by currency code; 100 USD + 200 EUR is NOT "300 USD".
    expect(totals).toEqual([
      { currency: "EUR", amount: 20_000 },
      { currency: "USD", amount: 10_000 },
    ]);
  });

  test("excludes non-billable entries from the amount", () => {
    const totals = summarizeBillableAmountByCurrency([
      entry(),
      entry({ billable: false }),
    ]);
    expect(totals).toEqual([{ currency: "USD", amount: 10_000 }]);
  });

  test("empty entries produce no subtotals", () => {
    expect(summarizeBillableAmountByCurrency([])).toEqual([]);
  });
});

describe("matterCurrencyMap", () => {
  test("maps each matter to its own currency", () => {
    const map = matterCurrencyMap([
      entry({ matterId: "m1", currency: "USD" }),
      entry({ matterId: "m2", currency: "EUR" }),
      entry({ matterId: "m1", currency: "USD" }),
    ]);
    expect(map.get("m1")).toBe("USD");
    expect(map.get("m2")).toBe("EUR");
  });

  test("prefers a billable entry's currency over an earlier non-billable one", () => {
    // The row amount is billable-only, so the label must match the charged
    // currency, not the first (non-billable) entry's.
    const map = matterCurrencyMap([
      entry({ matterId: "m1", currency: "EUR", billable: false }),
      entry({ matterId: "m1", currency: "USD", billable: true }),
    ]);
    expect(map.get("m1")).toBe("USD");
  });

  test("falls back to any currency for matters with no billable time", () => {
    const map = matterCurrencyMap([
      entry({ matterId: "m1", currency: "EUR", billable: false }),
    ]);
    expect(map.get("m1")).toBe("EUR");
  });
});
