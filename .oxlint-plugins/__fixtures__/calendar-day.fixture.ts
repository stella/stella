// Passive regression fixture for `calendar-day/no-utc-user-day`.
import { Temporal, todayFor } from "@stll/time";

declare const createdAt: Date;
declare const viewerZone: string;

export const userDays = () => [
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: the UTC day is not the user's today
  Temporal.Now.plainDateISO("UTC"),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: a UTC wall-clock date carries the UTC day
  Temporal.Now.plainDateTimeISO("UTC"),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: a UTC zoned now carries the UTC day
  Temporal.Now.zonedDateTimeISO("UTC"),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: converting now to UTC reads the UTC day
  Temporal.Now.instant().toZonedDateTimeISO("UTC"),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: the owner called with UTC is still the UTC day
  todayFor("UTC"),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: an ISO prefix is the UTC day
  createdAt.toISOString().slice(0, 10),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: toJSON is the same ISO string
  createdAt.toJSON().slice(0, 10),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: splitting at T keeps the UTC date
  createdAt.toISOString().split("T")[0],
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: at(0) after the split keeps the UTC date
  createdAt.toISOString().split("T").at(0),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: an instant's string is UTC
  Temporal.Now.instant().toString().slice(0, 10),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: the UTC day of the month
  createdAt.getUTCDate(),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: the UTC weekday
  createdAt.getUTCDay(),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: the UTC month
  createdAt.getUTCMonth(),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: the UTC year
  createdAt.getUTCFullYear(),
  // expect-clean: calendar-day/no-utc-user-day
  todayFor(viewerZone),
  // expect-clean: calendar-day/no-utc-user-day
  Temporal.Now.plainDateISO(viewerZone),
  // expect-clean: calendar-day/no-utc-user-day
  createdAt.toISOString(),
  // expect-clean: calendar-day/no-utc-user-day
  createdAt.toISOString().slice(0, 19),
  // expect-clean: calendar-day/no-utc-user-day
  createdAt.getUTCHours(),
];
