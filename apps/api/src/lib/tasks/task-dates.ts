import { parsePlainDate } from "@stll/time";

/**
 * True when `value` is an ISO `YYYY-MM-DD` day that exists on the calendar
 * and that a Postgres `date` column stores. The `date` body format accepts
 * any string `Date` can parse, which rolls an impossible day over to the
 * next month, so it cannot stand in for this check. Postgres has no year 0.
 */
export const isStorableCalendarDate = (value: string): boolean => {
  const date = parsePlainDate(value);
  return date !== null && date.year >= 1;
};

/** True when every present date in `values` is a storable calendar date. */
export const areStorableCalendarDates = (
  values: readonly (string | null | undefined)[],
): boolean =>
  values.every(
    (value) =>
      value === undefined || value === null || isStorableCalendarDate(value),
  );
