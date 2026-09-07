import { parseIsoDateLocal } from "@stll/time";

// Registry date fields represent calendar dates, even when serialized at midnight.
// Preserve the source day instead of shifting it through the viewer's time zone.
const REGISTRY_CALENDAR_DATE =
  /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/u;

export const parseRegistryCalendarDate = (value: string): Date | null => {
  const day = REGISTRY_CALENDAR_DATE.exec(value)?.at(1);
  return day ? parseIsoDateLocal(day) : null;
};
