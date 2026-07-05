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
export const formatTodayInTimeZone = ({
  timezoneId,
  now = new Date(),
}: FormatTodayInTimeZoneProps): Result<string, HandlerError<400>> =>
  Result.try({
    // en-CA locale formats dates as YYYY-MM-DD (ISO 8601)
    try: () =>
      new Intl.DateTimeFormat("en-CA", { timeZone: timezoneId }).format(now),
    catch: () =>
      new HandlerError({
        status: 400,
        message: "Invalid timezone identifier",
      }),
  });
