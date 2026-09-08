import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

export type CalendarDateRange = {
  endDateExclusive: string;
  startDate: string;
};

export type ResourceCalendarPlacement = {
  columnStart: number;
  span: number;
};

export type ResourceCalendarLanePlacement = ResourceCalendarPlacement & {
  entryId: string;
  rowStart: number;
};

export type ResourceCalendarLaneLayout = {
  placements: ResourceCalendarLanePlacement[];
  rowCount: number;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const toPlainDate = (value: string): Temporal.PlainDate | null => {
  if (!ISO_DATE_PATTERN.test(value)) {
    return null;
  }
  return Result.try(() => Temporal.PlainDate.from(value)).unwrapOr(null);
};

const differenceInCalendarDays = (later: string, earlier: string): number => {
  const laterDate = toPlainDate(later);
  const earlierDate = toPlainDate(earlier);
  if (laterDate === null || earlierDate === null) {
    throw new RangeError(
      "Calendar dates must use normalized YYYY-MM-DD values",
    );
  }
  return laterDate.since(earlierDate, { largestUnit: "days" }).days;
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
  if (first === undefined || toPlainDate(first) === null) {
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
  const date = toPlainDate(value);
  if (date === null) {
    throw new RangeError(
      "Calendar dates must use normalized YYYY-MM-DD values",
    );
  }
  const nextDate = date.add({ days: 1 }).toString();
  if (toPlainDate(nextDate) === null) {
    throw new RangeError(
      "Calendar dates must have a following normalized YYYY-MM-DD value",
    );
  }
  return nextDate;
};

export const layoutResourceCalendarEntries = (
  entries: readonly (CalendarDateRange & { id: string })[],
  visibleRange: CalendarDateRange,
): ResourceCalendarLaneLayout => {
  const visibleEntries: (ResourceCalendarPlacement & {
    entryId: string;
  })[] = [];
  const entryIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.id)) {
      throw new TypeError("Resource calendar entry ids must be unique");
    }
    entryIds.add(entry.id);
    const placement = getResourceCalendarPlacement({ entry, visibleRange });
    if (placement === null) {
      continue;
    }
    visibleEntries.push({
      columnStart: placement.columnStart,
      entryId: entry.id,
      span: placement.span,
    });
  }
  visibleEntries.sort((left, right) => {
    const startDifference = left.columnStart - right.columnStart;
    if (startDifference !== 0) {
      return startDifference;
    }
    if (left.entryId < right.entryId) {
      return -1;
    }
    if (left.entryId > right.entryId) {
      return 1;
    }
    return 0;
  });

  const laneEnds: number[] = [];
  const placements: ResourceCalendarLanePlacement[] = [];
  for (const entry of visibleEntries) {
    const firstAvailableLane = laneEnds.findIndex(
      (laneEnd) => laneEnd <= entry.columnStart,
    );
    const lane =
      firstAvailableLane === -1 ? laneEnds.length : firstAvailableLane;
    laneEnds[lane] = entry.columnStart + entry.span;
    placements.push({
      columnStart: entry.columnStart,
      entryId: entry.entryId,
      rowStart: lane + 1,
      span: entry.span,
    });
  }

  return {
    placements,
    rowCount: Math.max(1, laneEnds.length),
  };
};
