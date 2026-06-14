import { type CentsAmount, prorateHourlyCents } from "@stll/money";

/**
 * The fields of a time entry the weekly timesheet totals depend on.
 * Structural so the query result (which has more fields) satisfies it.
 */
export type TimesheetTotalEntry = {
  matterId: string;
  currency: string;
  billable: boolean;
  billedMinutes: number;
  rateAtEntry: CentsAmount;
};

export type CurrencyAmount = { currency: string; amount: number };

/**
 * Billable amount summed per currency. There is no FX conversion, so a week
 * that mixes currencies must be reported as one subtotal per currency, never
 * collapsed into a single number under one (first-entry) symbol.
 */
export const summarizeBillableAmountByCurrency = (
  entries: readonly TimesheetTotalEntry[],
): CurrencyAmount[] => {
  const byCurrency = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.billable) {
      continue;
    }
    const amount = prorateHourlyCents({
      billedMinutes: entry.billedMinutes,
      hourlyRateCents: entry.rateAtEntry,
    });
    byCurrency.set(
      entry.currency,
      (byCurrency.get(entry.currency) ?? 0) + amount,
    );
  }
  return [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
};

/**
 * Each matter's display currency. The row amount is summed from billable
 * entries only, so prefer a billable entry's currency (a non-billable entry
 * in another currency must not mislabel the charged subtotal). Fall back to
 * any entry's currency for matters with no billable time, whose amount is 0
 * and therefore not shown.
 */
export const matterCurrencyMap = (
  entries: readonly TimesheetTotalEntry[],
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.billable && !map.has(entry.matterId)) {
      map.set(entry.matterId, entry.currency);
    }
  }
  for (const entry of entries) {
    if (!map.has(entry.matterId)) {
      map.set(entry.matterId, entry.currency);
    }
  }
  return map;
};
