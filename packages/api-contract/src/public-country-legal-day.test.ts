import { describe, expect, test } from "bun:test";

import { PUBLIC_COUNTRIES } from "./public-country-capability";
import {
  legalDayTimeZone,
  PUBLIC_COUNTRY_LEGAL_DAY_TIME_ZONE,
} from "./public-country-legal-day";

/** The calendar date an instant falls on in a zone, as `YYYY-MM-DD`. */
const dateIn = (timeZone: string, instant: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);

describe("public country legal day", () => {
  test("states a zone for exactly the public countries", () => {
    expect(Object.keys(PUBLIC_COUNTRY_LEGAL_DAY_TIME_ZONE).toSorted()).toEqual(
      [...PUBLIC_COUNTRIES].toSorted(),
    );
  });

  test.each(PUBLIC_COUNTRIES)(
    "%s names a zone the runtime resolves",
    (country) => {
      // An unknown zone throws a RangeError here rather than reading as UTC.
      expect(dateIn(legalDayTimeZone(country), new Date(0))).toMatch(
        /^\d{4}-\d{2}-\d{2}$/u,
      );
    },
  );

  test("a route segment reads the same zone as the stored country code", () => {
    expect(legalDayTimeZone("hun")).toBe(legalDayTimeZone("HUN"));
    expect(legalDayTimeZone("cze")).toBe(legalDayTimeZone("CZE"));
  });

  test("a Hungarian legal day turns at Budapest midnight, not at UTC midnight", () => {
    // 23:30 UTC on 18 November is already 19 November in Budapest (UTC+1).
    const lateEvening = new Date("2026-11-18T23:30:00Z");
    expect(dateIn("UTC", lateEvening)).toBe("2026-11-18");
    expect(dateIn(legalDayTimeZone("HUN"), lateEvening)).toBe("2026-11-19");
  });
});
