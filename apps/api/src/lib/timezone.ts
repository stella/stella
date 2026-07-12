import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

type FormatTodayInTimeZoneProps = {
  timezoneId: string;
  now?: Date;
};

/**
 * Formats "today" as an ISO (YYYY-MM-DD) date string in the given IANA
 * timezone id. `Intl.DateTimeFormat` throws a `RangeError` for an invalid
 * timezone id, so this wraps the call in a `Result` and surfaces a 400
 * `HandlerError` instead of letting the exception reach the client as an
 * unhandled 500.
 */
// Locale is fixed ("en-CA" for YYYY-MM-DD); only the IANA timezone varies per
// call, so each formatter is cached once per timezone instead of rebuilt
// every call. A formatter is only stored after construction succeeds, so an
// invalid timezoneId keeps throwing (and never poisons the cache).
const isoDateFormattersByTimeZone = new Map<string, Intl.DateTimeFormat>();
const getIsoDateFormatter = (timezoneId: string): Intl.DateTimeFormat => {
  let formatter = isoDateFormattersByTimeZone.get(timezoneId);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezoneId });
    isoDateFormattersByTimeZone.set(timezoneId, formatter);
  }
  return formatter;
};

export const formatTodayInTimeZone = ({
  timezoneId,
  now = new Date(),
}: FormatTodayInTimeZoneProps): Result<string, HandlerError<400>> =>
  Result.try({
    try: () => getIsoDateFormatter(timezoneId).format(now),
    catch: () =>
      new HandlerError({
        status: 400,
        message: "Invalid timezone identifier",
      }),
  });
