import { addDays, parseIsoDateLocal } from "@stll/time";
import { localISODate } from "@/lib/local-iso-date";

const MAX_TIME_ENTRY_AGE_DAYS = 90;

export type TimeEntryDateBounds = {
  earliestDate: string;
  today: string;
};

export const getTimeEntryDateBounds = (
  today = localISODate(),
): TimeEntryDateBounds => ({
  earliestDate: localISODate(
    addDays(parseIsoDateLocal(today) ?? new Date(), -MAX_TIME_ENTRY_AGE_DAYS),
  ),
  today,
});

export const isTimeEntryDateAllowed = (
  date: string,
  bounds: TimeEntryDateBounds = getTimeEntryDateBounds(),
): boolean => date >= bounds.earliestDate && date <= bounds.today;
