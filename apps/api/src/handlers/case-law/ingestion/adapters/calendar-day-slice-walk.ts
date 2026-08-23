import { panic } from "better-result";

import type { AdapterKey } from "@/api/handlers/case-law/consts";
import { addUtcDays, isoCalendarDay, toUtcDateString } from "@/api/lib/dates";

type CalendarDaySliceWalkOptions = {
  firstSlice: string;
  source: AdapterKey;
};

export const createCalendarDaySliceWalk = ({
  firstSlice,
  source,
}: CalendarDaySliceWalkOptions) => {
  const dayStart = (slice: string): Date => {
    const day = isoCalendarDay(slice);
    if (day === null || day !== slice) {
      panic(`${source} slice is not a UTC calendar day: ${slice}`);
    }
    return new Date(`${day}T00:00:00.000Z`);
  };

  const stepSlice = (slice: string, days: number): string =>
    toUtcDateString(addUtcDays(dayStart(slice), days));

  const nextSlice = (slice: string): string | null => {
    const next = stepSlice(slice, 1);
    return next > toUtcDateString(new Date()) ? null : next;
  };

  const previousSlice = (slice: string): string | null => {
    const previous = stepSlice(slice, -1);
    return previous < firstSlice ? null : previous;
  };

  return {
    dayStart,
    walk: {
      sliceOf: toUtcDateString,
      nextSlice,
      previousSlice,
    },
  };
};
