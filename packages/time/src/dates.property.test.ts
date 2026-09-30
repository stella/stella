import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  addDays,
  isIsoDateString,
  parseIsoDateLocal,
  parsePlainDate,
} from "./dates";

let originalTz: string | undefined;
beforeEach(() => {
  originalTz = process.env.TZ;
});
afterEach(() => {
  process.env.TZ = originalTz ?? "";
});

const config = () => propertyConfig({ seed: propertySeed() });
const dateParts = fc.record({
  year: fc.oneof(
    fc.integer({ min: 0, max: 9999 }),
    fc.constantFrom(0, 1, 1900, 2000, 2024, 2100),
  ),
  month: fc.integer({ min: 0, max: 13 }),
  day: fc.integer({ min: 0, max: 32 }),
});

type DateParts = { year: number; month: number; day: number };
const dateString = ({ year, month, day }: DateParts) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

// Independent Gregorian oracle: no Date or Temporal parsing/normalization.
const isCalendarDay = ({ year, month, day }: DateParts) => {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month === 2) {
    return day <= (leap ? 29 : 28);
  }
  if ([4, 6, 9, 11].includes(month)) {
    return day <= 30;
  }
  return day <= 31;
};

const dateInput = fc.oneof(
  fc.string(),
  dateParts.map(dateString),
  dateParts.chain((parts) =>
    fc.constantFrom(
      `${dateString(parts)}T00:00:00Z`,
      ` ${dateString(parts)}`,
      `${dateString(parts)}\n`,
      `${parts.year}-${parts.month}-${parts.day}`,
    ),
  ),
);
const ZONES = [
  "UTC",
  "Europe/Prague",
  "America/New_York",
  "Pacific/Auckland",
  "Australia/Lord_Howe",
] as const;
const modernDay = fc.record({
  year: fc.integer({ min: 1990, max: 2040 }),
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.constantFrom(1, 7, 8, 9, 10, 24, 25, 26, 27, 28),
});
const dayShift = fc.oneof(
  fc.integer({ min: -800, max: 800 }),
  fc.constantFrom(-366, -365, -1, 0, 1, 365, 366),
);

describe("calendar dates (properties)", () => {
  test(
    "accepts exactly the real Gregorian days in four-digit form",
    () => {
      fc.assert(
        fc.property(dateParts, (parts) => {
          for (const candidate of [
            parts,
            { year: parts.year, month: 2, day: 29 },
            { ...parts, day: 31 },
          ]) {
            const value = dateString(candidate);
            expect(isIsoDateString(value)).toBe(true);
            const parsed = parsePlainDate(value);
            expect(parsed !== null).toBe(isCalendarDay(candidate));
            if (parsed !== null) {
              expect(parsed.toString()).toBe(value);
              expect([parsed.year, parsed.month, parsed.day]).toEqual([
                candidate.year,
                candidate.month,
                candidate.day,
              ]);
            }
          }
        }),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "successful parsing implies ISO shape and an unchanged round trip",
    () => {
      fc.assert(
        fc.property(dateInput, (value) => {
          const parsed = parsePlainDate(value);
          if (parsed !== null) {
            expect(isIsoDateString(value)).toBe(true);
            expect(parsed.toString()).toBe(value);
            expect(isCalendarDay(parsed)).toBe(true);
          }
          if (!isIsoDateString(value)) {
            expect(parsed).toBeNull();
            expect(parseIsoDateLocal(value)).toBeNull();
          }
        }),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "local adaptation preserves the calendar day across timezones",
    () => {
      fc.assert(
        fc.property(modernDay, (parts) => {
          for (const zone of ZONES) {
            process.env.TZ = zone;
            const parsed = parseIsoDateLocal(dateString(parts));
            expect(parsed).not.toBeNull();
            if (parsed === null) {
              return;
            }
            expect([
              parsed.getFullYear(),
              parsed.getMonth() + 1,
              parsed.getDate(),
            ]).toEqual([parts.year, parts.month, parts.day]);
            expect(parsed.getHours()).toBe(0);
          }
        }),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );
});

describe("calendar arithmetic (properties)", () => {
  test(
    "inverts day shifts at local noon across DST and leap years",
    () => {
      fc.assert(
        fc.property(modernDay, dayShift, (parts, shift) => {
          for (const zone of ZONES) {
            process.env.TZ = zone;
            const start = new Date(parts.year, parts.month - 1, parts.day, 12);
            const timestamp = start.getTime();
            const shifted = addDays(start, shift);
            expect(addDays(shifted, -shift).getTime()).toBe(timestamp);
            expect(start.getTime()).toBe(timestamp);
            expect(shifted.getHours()).toBe(12);
            const expectedDay = new Date(
              Date.UTC(parts.year, parts.month - 1, parts.day + shift),
            );
            expect([
              shifted.getFullYear(),
              shifted.getMonth(),
              shifted.getDate(),
            ]).toEqual([
              expectedDay.getUTCFullYear(),
              expectedDay.getUTCMonth(),
              expectedDay.getUTCDate(),
            ]);
          }
        }),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "preserves existing local wall-clock times across seasonal transitions",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1990, max: 2040 }),
          fc.integer({ min: 4, max: 23 }),
          fc.integer({ min: 0, max: 59 }),
          fc.integer({ min: 0, max: 999 }),
          (year, hour, minute, milliseconds) => {
            // These hours exist on both sides of every transition in these zones.
            for (const zone of ZONES) {
              process.env.TZ = zone;
              for (const month of [2, 3, 9, 10]) {
                const start = new Date(
                  year,
                  month,
                  1,
                  hour,
                  minute,
                  17,
                  milliseconds,
                );
                const shifted = addDays(start, 35);
                expect([
                  shifted.getHours(),
                  shifted.getMinutes(),
                  shifted.getSeconds(),
                  shifted.getMilliseconds(),
                ]).toEqual([hour, minute, 17, milliseconds]);
              }
            }
          },
        ),
        config(),
      );
    },
    propertyTestTimeout(5000),
  );
});
