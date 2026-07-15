type FormatDateTimeInTimeZoneProps = {
  date?: Date | undefined;
  timezone: string;
};

// Locale is fixed ("en-US"); only the IANA timezone varies per call, so each
// formatter shape is cached once per timezone instead of rebuilt every call.
const dateTimeFormattersByTimeZone = new Map<string, Intl.DateTimeFormat>();
const getDateTimeFormatter = (timezone: string): Intl.DateTimeFormat => {
  let formatter = dateTimeFormattersByTimeZone.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    dateTimeFormattersByTimeZone.set(timezone, formatter);
  }
  return formatter;
};

export const formatDateTimeInTimeZone = ({
  date = new Date(),
  timezone,
}: FormatDateTimeInTimeZoneProps) => {
  try {
    return getDateTimeFormatter(timezone).format(date);
  } catch {
    return date.toISOString();
  }
};

const dateFormattersByTimeZone = new Map<string, Intl.DateTimeFormat>();
const getDateFormatter = (timezone: string): Intl.DateTimeFormat => {
  let formatter = dateFormattersByTimeZone.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    dateFormattersByTimeZone.set(timezone, formatter);
  }
  return formatter;
};

/**
 * Day-granularity variant of {@link formatDateTimeInTimeZone}. Used
 * where the value lands in a cacheable prompt: a minute-precise
 * timestamp would change the text on every request and defeat prompt
 * caching, while the calendar date is all the model needs.
 */
export const formatDateInTimeZone = ({
  date = new Date(),
  timezone,
}: FormatDateTimeInTimeZoneProps) => {
  try {
    return getDateFormatter(timezone).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

type FormatIsoDateForDisplayProps = {
  isoDate: string;
};

export const formatIsoDateForDisplay = ({
  isoDate,
}: FormatIsoDateForDisplayProps) => {
  const [year, month, day] = isoDate.split("-");
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};
