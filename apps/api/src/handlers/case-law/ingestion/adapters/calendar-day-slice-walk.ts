import { panic } from "better-result";

import { parsePlainDate, Temporal } from "@stll/time";

import type { AdapterKey } from "@/api/handlers/case-law/consts";
import { toUtcDateString } from "@/api/lib/dates";

type CalendarDaySliceWalkOptions = {
  firstSlice: string;
  source: AdapterKey;
};

export const createCalendarDaySliceWalk = ({
  firstSlice,
  source,
}: CalendarDaySliceWalkOptions) => {
  const sliceDate = (slice: string) => {
    const day = parsePlainDate(slice);
    if (day === null) {
      panic(`${source} slice is not a UTC calendar day: ${slice}`);
    }
    return day;
  };

  const dayStart = (slice: string): Date =>
    new Date(sliceDate(slice).toZonedDateTime("UTC").epochMilliseconds);

  const stepSlice = (slice: string, days: number): string =>
    sliceDate(slice).add({ days }).toString();

  const nextSlice = (slice: string): string | null => {
    const next = stepSlice(slice, 1);
    return next > Temporal.Now.plainDateISO("UTC").toString() ? null : next;
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
