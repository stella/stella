import { Temporal } from "@stll/time";

import type { FactDatePrecision } from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import { UTC_MEDIUM_DATE_FORMAT } from "@/lib/relative-time";

/**
 * A fact's date as precisely as it is known: a partial date is stored as its
 * first day, so a month-precision date must never render that day. Read in
 * UTC, the timezone date-only values are written in.
 */
const FACT_DATE_FORMATS = {
  day: UTC_MEDIUM_DATE_FORMAT,
  month: { year: "numeric", month: "long", timeZone: "UTC" },
  year: { year: "numeric", timeZone: "UTC" },
} as const satisfies Record<FactDatePrecision, Intl.DateTimeFormatOptions>;

type FactDateProps = {
  occurredOn: string | null;
  precision: FactDatePrecision | null;
};

export const FactDate = ({ occurredOn, precision }: FactDateProps) => {
  const format = useFormatter();
  if (occurredOn === null || precision === null) {
    return null;
  }
  const instant = Temporal.PlainDate.from(occurredOn).toZonedDateTime({
    timeZone: "UTC",
  }).epochMilliseconds;
  return <span>{format.dateTime(instant, FACT_DATE_FORMATS[precision])}</span>;
};
