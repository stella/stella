export type CalendarDateRange = {
  endDateExclusive: string;
  startDate: string;
};

export type ResourceCalendarPlacement = {
  columnStart: number;
  span: number;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_IN_MS = 86_400_000;

const toUTCDate = (value: string): Date | null => {
  if (!ISO_DATE_PATTERN.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value ? date : null;
};

const differenceInCalendarDays = (later: string, earlier: string): number => {
  const laterDate = toUTCDate(later);
  const earlierDate = toUTCDate(earlier);
  if (laterDate === null || earlierDate === null) {
    throw new RangeError(
      "Calendar dates must use normalized YYYY-MM-DD values",
    );
  }
  return (laterDate.getTime() - earlierDate.getTime()) / DAY_IN_MS;
};

export const getResourceCalendarPlacement = ({
  entry,
  visibleRange,
}: {
  entry: CalendarDateRange;
  visibleRange: CalendarDateRange;
}): ResourceCalendarPlacement | null => {
  const visibleDayCount = differenceInCalendarDays(
    visibleRange.endDateExclusive,
    visibleRange.startDate,
  );
  const entryDayCount = differenceInCalendarDays(
    entry.endDateExclusive,
    entry.startDate,
  );
  if (visibleDayCount <= 0 || entryDayCount <= 0) {
    throw new RangeError(
      "Calendar date ranges must be non-empty and half-open",
    );
  }
  if (
    entry.startDate >= visibleRange.endDateExclusive ||
    entry.endDateExclusive <= visibleRange.startDate
  ) {
    return null;
  }

  const clippedStart =
    entry.startDate < visibleRange.startDate
      ? visibleRange.startDate
      : entry.startDate;
  const clippedEnd =
    entry.endDateExclusive > visibleRange.endDateExclusive
      ? visibleRange.endDateExclusive
      : entry.endDateExclusive;

  return {
    columnStart:
      differenceInCalendarDays(clippedStart, visibleRange.startDate) + 2,
    span: differenceInCalendarDays(clippedEnd, clippedStart),
  };
};

export const assertConsecutiveCalendarDates = (
  dates: readonly string[],
): void => {
  if (dates.length === 0) {
    throw new RangeError("A resource calendar needs at least one date column");
  }

  const first = dates.at(0);
  if (first === undefined || toUTCDate(first) === null) {
    throw new RangeError(
      "Resource calendar date columns must be consecutive normalized dates",
    );
  }

  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates.at(index - 1);
    const current = dates.at(index);
    if (
      previous === undefined ||
      current === undefined ||
      differenceInCalendarDays(current, previous) !== 1
    ) {
      throw new RangeError(
        "Resource calendar date columns must be consecutive normalized dates",
      );
    }
  }
};

export const nextCalendarDate = (value: string): string => {
  const date = toUTCDate(value);
  if (date === null) {
    throw new RangeError(
      "Calendar dates must use normalized YYYY-MM-DD values",
    );
  }
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};
