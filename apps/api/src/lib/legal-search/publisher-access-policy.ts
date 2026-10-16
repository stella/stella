// parser-output-unchanged: publisher access admission and connection lifetime change request scheduling; successful payload parsing is unchanged.
import { panic } from "better-result";

import { Temporal } from "@stll/time";

export type PublisherAccessPolicy =
  | { type: "unrestricted" }
  | { type: "scheduled"; schedule: "austrian-off-hours" };

// Nationwide holidays under Arbeitsruhegesetz § 7(2), excluding regional holidays:
// https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008541&Paragraf=7
// Official dated calendar: https://www.wien.gv.at/inhalt/feiertage
// Later years apply the same statutory dates and Easter-relative feast days.
// Renew this bounded table before its last year expires; never infer an unknown year.
export const AUSTRIAN_NATIONAL_HOLIDAYS = {
  2026: [
    "2026-01-01",
    "2026-01-06",
    "2026-04-06",
    "2026-05-01",
    "2026-05-14",
    "2026-05-25",
    "2026-06-04",
    "2026-08-15",
    "2026-10-26",
    "2026-11-01",
    "2026-12-08",
    "2026-12-25",
    "2026-12-26",
  ],
  2027: [
    "2027-01-01",
    "2027-01-06",
    "2027-03-29",
    "2027-05-01",
    "2027-05-06",
    "2027-05-17",
    "2027-05-27",
    "2027-08-15",
    "2027-10-26",
    "2027-11-01",
    "2027-12-08",
    "2027-12-25",
    "2027-12-26",
  ],
  2028: [
    "2028-01-01",
    "2028-01-06",
    "2028-04-17",
    "2028-05-01",
    "2028-05-25",
    "2028-06-05",
    "2028-06-15",
    "2028-08-15",
    "2028-10-26",
    "2028-11-01",
    "2028-12-08",
    "2028-12-25",
    "2028-12-26",
  ],
  2029: [
    "2029-01-01",
    "2029-01-06",
    "2029-04-02",
    "2029-05-01",
    "2029-05-10",
    "2029-05-21",
    "2029-05-31",
    "2029-08-15",
    "2029-10-26",
    "2029-11-01",
    "2029-12-08",
    "2029-12-25",
    "2029-12-26",
  ],
  2030: [
    "2030-01-01",
    "2030-01-06",
    "2030-04-22",
    "2030-05-01",
    "2030-05-30",
    "2030-06-10",
    "2030-06-20",
    "2030-08-15",
    "2030-10-26",
    "2030-11-01",
    "2030-12-08",
    "2030-12-25",
    "2030-12-26",
  ],
  2031: [
    "2031-01-01",
    "2031-01-06",
    "2031-04-14",
    "2031-05-01",
    "2031-05-22",
    "2031-06-02",
    "2031-06-12",
    "2031-08-15",
    "2031-10-26",
    "2031-11-01",
    "2031-12-08",
    "2031-12-25",
    "2031-12-26",
  ],
} as const satisfies Record<
  2026 | 2027 | 2028 | 2029 | 2030 | 2031,
  readonly string[]
>;

const VIENNA_TIME_ZONE = "Europe/Vienna";
const OPENING_HOUR = 20;
const CLOSING_HOUR = 5;

const calendarFor = (year: number): readonly string[] | undefined =>
  Object.entries(AUSTRIAN_NATIONAL_HOLIDAYS).find(
    ([candidate]) => Number(candidate) === year,
  )?.[1];

const isFullOpenDay = (date: Temporal.PlainDate, holidays: readonly string[]) =>
  date.dayOfWeek >= 6 || holidays.includes(date.toString());

const atHour = (date: Temporal.PlainDate, hour: number) =>
  date.toZonedDateTime({ timeZone: VIENNA_TIME_ZONE, plainTime: { hour } })
    .epochMilliseconds;

type PublisherAccessEvaluation =
  | { type: "open"; closesAt: number | null }
  | { type: "closed"; opensAt: number }
  | { type: "unavailable"; reason: "unsupported-calendar-year" };

export const evaluatePublisherAccessPolicy = (
  policy: PublisherAccessPolicy,
  epochMilliseconds: number,
): PublisherAccessEvaluation => {
  switch (policy.type) {
    case "unrestricted":
      return { type: "open", closesAt: null };
    case "scheduled":
      break;
    default:
      policy satisfies never;
      return panic("Unhandled publisher access policy");
  }
  const now =
    Temporal.Instant.fromEpochMilliseconds(
      epochMilliseconds,
    ).toZonedDateTimeISO(VIENNA_TIME_ZONE);
  let date = now.toPlainDate();
  const holidays = calendarFor(date.year);
  if (holidays === undefined) {
    return { type: "unavailable", reason: "unsupported-calendar-year" };
  }
  if (!isFullOpenDay(date, holidays)) {
    if (now.hour >= CLOSING_HOUR && now.hour < OPENING_HOUR) {
      return { type: "closed", opensAt: atHour(date, OPENING_HOUR) };
    }
    if (now.hour < CLOSING_HOUR) {
      return { type: "open", closesAt: atHour(date, CLOSING_HOUR) };
    }
  }
  // Adjacent nights, weekends and holidays form one continuous window.
  // Calendar arithmetic preserves local boundaries through both DST changes.
  for (;;) {
    date = date.add({ days: 1 });
    const nextHolidays = calendarFor(date.year);
    if (nextHolidays === undefined) {
      return { type: "open", closesAt: atHour(date, 0) };
    }
    if (!isFullOpenDay(date, nextHolidays)) {
      return { type: "open", closesAt: atHour(date, CLOSING_HOUR) };
    }
  }
};
