import type { TimeEntry } from "@stll/api-contract/time-entry-types";
import { type CentsAmount, timeEntryAmount } from "@stll/money";

import { timeEntryContextKey } from "./time-entry-context.logic";

/**
 * The fields of a time entry the weekly timesheet totals depend on.
 * Structural so the query result (which has more fields) satisfies it.
 */
export type TimesheetTotalEntry = {
  workItemId: string | null;
  workItemReference: TimeEntry["workItemReference"];
  currency: string;
  billable: boolean;
  noCharge: boolean;
  billedMinutes: number;
  rateAtEntry: CentsAmount;
};

export type CurrencyAmount = { currency: string; amount: number };

const sortedCurrencyAmounts = (
  byCurrency: Map<string, number>,
): CurrencyAmount[] =>
  [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    // oxlint-disable-next-line require-cached-collator/require-cached-collator -- ISO 4217 currency codes are fixed ASCII codes, not locale-sensitive display text
    .toSorted((a, b) => a.currency.localeCompare(b.currency));

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
    const amount = timeEntryAmount(entry);
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
): Map<string | null, CurrencyAmount[]> => {
  const byMatter = new Map<string | null, Map<string, number>>();
  for (const entry of entries) {
    if (!entry.billable) {
      continue;
    }
    const contextKey = timeEntryContextKey(entry);
    let byCurrency = byMatter.get(contextKey);
    if (!byCurrency) {
      byCurrency = new Map<string, number>();
      byMatter.set(contextKey, byCurrency);
    }
    const amount = timeEntryAmount(entry);
    byCurrency.set(
      entry.currency,
      (byCurrency.get(entry.currency) ?? 0) + amount,
    );
  }

  return new Map(
    [...byMatter.entries()].map(([workItemId, byCurrency]) => [
      workItemId,
      sortedCurrencyAmounts(byCurrency),
    ]),
  );
};
