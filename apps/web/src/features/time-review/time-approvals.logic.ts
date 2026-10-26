import { UNPRICED_TIME_ENTRY_CURRENCY } from "@stll/api-contract";
import { compareByLocale } from "@stll/collation";
import { type CentsAmount, timeEntryAmount } from "@stll/money";

import type { TimeReviewRowData } from "@/features/time-review/time-review-row";

export type ReviewRowWithPerson = TimeReviewRowData & {
  timekeeperId: string | null;
};

export type PersonReview = {
  timekeeperId: string | null;
  timekeeperName: string | null;
  billedMinutes: number;
  /** Amounts by currency; unpriced time counts in minutes only. */
  amounts: { currency: string; amount: number }[];
  days: { date: string; rows: ReviewRowWithPerson[] }[];
};

const groupByKey = <T>(items: readonly T[], keyOf: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
};

const totalsOf = (rows: readonly ReviewRowWithPerson[]) => {
  let billedMinutes = 0;
  const amounts = new Map<string, number>();
  for (const row of rows) {
    billedMinutes += row.billedMinutes;
    if (row.currency !== UNPRICED_TIME_ENTRY_CURRENCY) {
      const amount: CentsAmount = timeEntryAmount(row);
      amounts.set(row.currency, (amounts.get(row.currency) ?? 0) + amount);
    }
  }
  return {
    billedMinutes,
    amounts: [...amounts].map(([currency, amount]) => ({ currency, amount })),
  };
};

/**
 * Rows grouped the way an approver reads them: by person (in name order),
 * then by work date, with each person's billed time and amounts.
 */
export const groupForReview = (
  rows: readonly ReviewRowWithPerson[],
  locale: string,
): PersonReview[] => {
  const compareNames = compareByLocale(locale);
  return [...groupByKey(rows, (row) => row.timekeeperId ?? "")]
    .map(([, personRows]) => {
      const first = personRows[0];
      return {
        timekeeperId: first === undefined ? null : first.timekeeperId,
        timekeeperName: first === undefined ? null : first.timekeeperName,
        ...totalsOf(personRows),
        days: [...groupByKey(personRows, (row) => row.dateWorked)]
          .map(([date, dayRows]) => ({ date, rows: dayRows }))
          .toSorted((a, b) => (a.date < b.date ? -1 : 1)),
      };
    })
    .toSorted((a, b) =>
      compareNames(a.timekeeperName ?? "", b.timekeeperName ?? ""),
    );
};
