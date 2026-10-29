type DayTotal = {
  dateWorked: string;
  loggedMinutes: number;
  billableMinutes: number;
};

export type WeekTotals = {
  loggedMinutes: number;
  billableMinutes: number;
  byDay: ReadonlyMap<string, number>;
};

/** Week and per-day totals from the server's per-date sums. */
export const weekTotals = (days: readonly DayTotal[]): WeekTotals => {
  let loggedMinutes = 0;
  let billableMinutes = 0;
  const byDay = new Map<string, number>();
  for (const day of days) {
    loggedMinutes += day.loggedMinutes;
    billableMinutes += day.billableMinutes;
    byDay.set(day.dateWorked, day.loggedMinutes);
  }
  return { loggedMinutes, billableMinutes, byDay };
};

type SuggestionDay = { date: string; matters: { items: unknown[] }[] };

/** Pending suggestions per date, for the week strip. */
export const pendingCountByDay = (
  days: readonly SuggestionDay[],
): ReadonlyMap<string, number> =>
  new Map(
    days.map((day) => [
      day.date,
      day.matters.reduce((sum, matter) => sum + matter.items.length, 0),
    ]),
  );
