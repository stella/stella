import { Temporal } from "@stll/time";

import { localISODate } from "@/lib/local-iso-date";

const MAX_TIME_ENTRY_AGE_DAYS = 90;

export type TimeEntryDateBounds = {
  earliestDate: string;
  today: string;
};

export const getTimeEntryDateBounds = (
  today = localISODate(),
): TimeEntryDateBounds => ({
  earliestDate: Temporal.PlainDate.from(today)
    .subtract({ days: MAX_TIME_ENTRY_AGE_DAYS })
    .toString(),
  today,
});

export const isTimeEntryDateAllowed = (
  date: string,
  bounds: TimeEntryDateBounds = getTimeEntryDateBounds(),
): boolean => date >= bounds.earliestDate && date <= bounds.today;
