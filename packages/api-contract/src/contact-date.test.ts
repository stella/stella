import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import {
  CONTACT_DATE_TIME_ZONE,
  contactBirthDateSchema,
  isValidContactBirthDate,
} from "./contact-date";

const CURRENT_INSTANT = Temporal.Instant.from("2026-10-28T11:00:00Z");

describe("contact birth date chronology", () => {
  // Today as the rule sees it: the earliest time zone, never UTC.
  const { year, month, day } = Temporal.Now.plainDateISO(
    CONTACT_DATE_TIME_ZONE,
  );

  test.each([
    { precision: "year", year: 1900 },
    { precision: "month", year: 1900, month: 1 },
    { precision: "day", year: 1900, month: 1, day: 1 },
    { precision: "year", year },
    { precision: "month", year, month },
    { precision: "day", year, month, day },
  ] as const)("accepts $precision precision through today", (value) => {
    expect(v.safeParse(contactBirthDateSchema, value).success).toBe(true);
  });

  test.each([
    { precision: "year", year: 0 },
    { precision: "year", year: 1899 },
    { precision: "year", year: year + 1 },
    { precision: "day", year: 2000, month: 2, day: 30 },
  ] as const)("rejects an impossible or out-of-range date", (value) => {
    expect(v.safeParse(contactBirthDateSchema, value).success).toBe(false);
  });
});

describe("contact birth date boundary", () => {
  test.each([
    { precision: "day", year: 2026, month: 10, day: 29 },
    { precision: "month", year: 2026, month: 10 },
    { precision: "year", year: 2026 },
  ] as const)("accepts $precision precision at the boundary", (value) => {
    expect(isValidContactBirthDate(value, CURRENT_INSTANT)).toBe(true);
  });

  test.each([
    { precision: "day", year: 2026, month: 10, day: 30 },
    { precision: "month", year: 2026, month: 11 },
    { precision: "year", year: 2027 },
  ] as const)("rejects $precision precision after the boundary", (value) => {
    expect(isValidContactBirthDate(value, CURRENT_INSTANT)).toBe(false);
  });

  test.each([
    { precision: "year", year: 1990.5 },
    { precision: "month", year: 1990, month: 1.5 },
    { precision: "day", year: 1990, month: 1, day: 2.5 },
  ] as const)("rejects fractional $precision parts", (value) => {
    expect(isValidContactBirthDate(value, CURRENT_INSTANT)).toBe(false);
  });

  test("the year turns at the earliest time zone, not at UTC", () => {
    // On the last UTC day of a year, the rule's zone is already in the next one.
    const lastUtcDay = Temporal.Instant.from("2026-12-31T12:00:00Z");
    expect(
      isValidContactBirthDate({ precision: "year", year: 2027 }, lastUtcDay),
    ).toBe(true);
    expect(
      isValidContactBirthDate(
        { precision: "day", year: 2027, month: 1, day: 2 },
        lastUtcDay,
      ),
    ).toBe(false);
  });

  test("uses the same instant boundary on browser and API hosts", () => {
    const browserInstant = CURRENT_INSTANT.toZonedDateTimeISO(
      CONTACT_DATE_TIME_ZONE,
    ).toInstant();
    const apiInstant = CURRENT_INSTANT.toZonedDateTimeISO("UTC").toInstant();
    const boundaryDate = {
      precision: "day",
      year: 2026,
      month: 10,
      day: 29,
    } as const;
    const futureDate = { ...boundaryDate, day: 30 };

    expect(isValidContactBirthDate(boundaryDate, browserInstant)).toBe(true);
    expect(isValidContactBirthDate(boundaryDate, apiInstant)).toBe(true);
    expect(isValidContactBirthDate(futureDate, browserInstant)).toBe(false);
    expect(isValidContactBirthDate(futureDate, apiInstant)).toBe(false);
  });
});
