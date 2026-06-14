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

const sortedCurrencyAmounts = (
  byCurrency: Map<string, number>,
): CurrencyAmount[] =>
  [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

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
  return sortedCurrencyAmounts(byCurrency);
};

/**
 * Billable amount summed by matter and currency. The matter row cannot use a
 * single currency label when its charged entries span multiple currencies.
 */
export const summarizeBillableAmountByMatterAndCurrency = (
  entries: readonly TimesheetTotalEntry[],
): Map<string, CurrencyAmount[]> => {
  const byMatter = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    if (!entry.billable) {
      continue;
    }
    let byCurrency = byMatter.get(entry.matterId);
    if (!byCurrency) {
      byCurrency = new Map<string, number>();
      byMatter.set(entry.matterId, byCurrency);
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

  return new Map(
    [...byMatter.entries()].map(([matterId, byCurrency]) => [
      matterId,
      sortedCurrencyAmounts(byCurrency),
    ]),
  );
};
