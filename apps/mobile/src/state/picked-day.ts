import { Temporal } from "temporal-polyfill/full";

/**
 * How a native date picker carries a calendar day as an instant: the zone it
 * reads instants in, and the time of day it is handed for a day.
 */
export type PickerClock = {
  readonly timeZone: string;
  readonly plainTime: string;
};

/**
 * SwiftUI keeps the device's calendar and zone. Noon is a time no
 * daylight-saving change moves to another day.
 */
export const swiftUiClock = (): PickerClock => ({
  timeZone: Temporal.Now.timeZoneId(),
  plainTime: "12:00",
});

/** Material's picker works in UTC days, each at its midnight. */
export const MATERIAL_CLOCK: PickerClock = {
  timeZone: "UTC",
  plainTime: "00:00",
};

/** The calendar day (YYYY-MM-DD) a native picker reported as `date`. */
export const pickedDay = (date: Date, clock: PickerClock): string =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(clock.timeZone)
    .toPlainDate()
    .toString();

/** A calendar day (YYYY-MM-DD) as a native picker's selection. */
export const pickerDate = (day: string, clock: PickerClock): Date =>
  new Date(
    Temporal.PlainDate.from(day).toZonedDateTime(clock).epochMilliseconds,
  );
