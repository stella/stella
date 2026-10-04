import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Temporal } from "temporal-polyfill/full";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { todayFor } from "./today";

// Zones with DST in either hemisphere, a 30-minute DST shift, half-hour and
// quarter-hour offsets, both sides of the date line and a zone that skipped a
// whole calendar day (Samoa, 2011-12-30).
const ZONES = [
  "UTC",
  "Europe/Prague",
  "America/New_York",
  "America/Los_Angeles",
  "America/St_Johns",
  "Pacific/Auckland",
  "Australia/Lord_Howe",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
  "Pacific/Apia",
] as const;

const MIN_MS = Date.UTC(1990, 0, 1);
const MAX_MS = Date.UTC(2040, 0, 1);

// Independent oracle: ICU's calendar fields for the zone, not Temporal.
const oracleCache = new Map<string, Intl.DateTimeFormat>();
const localDateOracle = (zone: string, epochMilliseconds: number): string => {
  let format = oracleCache.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      calendar: "gregory",
      day: "2-digit",
      month: "2-digit",
      numberingSystem: "latn",
      timeZone: zone,
      year: "numeric",
    });
    oracleCache.set(zone, format);
  }
  const parts = new Map(
    format
      .formatToParts(epochMilliseconds)
      .map((part) => [part.type, part.value] as const),
  );
  return `${parts.get("year") ?? "?"}-${parts.get("month") ?? "?"}-${parts.get("day") ?? "?"}`;
};

const zone = fc.constantFrom(...ZONES);
const anyInstant = fc.integer({ min: MIN_MS, max: MAX_MS });
// Offsets from a boundary: the minute around it, then up to a day away.
const nearBoundary = fc.oneof(
  fc.integer({ min: -60_000, max: 60_000 }),
  fc.integer({ min: -26 * 3_600_000, max: 26 * 3_600_000 }),
);

/** A DST (or other offset) transition of `zone` near `epochMilliseconds`. */
const transitionNear = (
  zoneId: string,
  epochMilliseconds: number,
): number | null =>
  Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
    .toZonedDateTimeISO(zoneId)
    .getTimeZoneTransition("next")?.epochMilliseconds ?? null;

describe("todayFor (properties)", () => {
  test(
    "is the zone's local calendar date for arbitrary instants",
    () => {
      assertProperty(
        "is the zone's local calendar date for arbitrary instants",
        fc.property(zone, anyInstant, (zoneId, epochMilliseconds) => {
          const today = todayFor(
            zoneId,
            Temporal.Instant.fromEpochMilliseconds(epochMilliseconds),
          );
          expect(today.toString()).toBe(
            localDateOracle(zoneId, epochMilliseconds),
          );
        }),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "is the zone's local calendar date around offset transitions",
    () => {
      assertProperty(
        "is the zone's local calendar date around offset transitions",
        fc.property(
          zone,
          anyInstant,
          nearBoundary,
          (zoneId, epochMilliseconds, offset) => {
            const transition = transitionNear(zoneId, epochMilliseconds);
            if (transition === null) {
              return;
            }
            const at = transition + offset;
            expect(
              todayFor(zoneId, Temporal.Instant.fromEpochMilliseconds(at)),
            ).toEqual(Temporal.PlainDate.from(localDateOracle(zoneId, at)));
          },
        ),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "changes exactly at local midnight, whatever the UTC day says",
    () => {
      assertProperty(
        "changes exactly at local midnight, whatever the UTC day says",
        fc.property(zone, anyInstant, (zoneId, epochMilliseconds) => {
          const midnight = Temporal.Instant.fromEpochMilliseconds(
            epochMilliseconds,
          )
            .toZonedDateTimeISO(zoneId)
            .startOfDay()
            .toInstant();
          const before = midnight.subtract({ milliseconds: 1 });
          const day = todayFor(zoneId, midnight);
          expect(day.toString()).toBe(
            localDateOracle(zoneId, midnight.epochMilliseconds),
          );
          expect(todayFor(zoneId, before).toString()).toBe(
            localDateOracle(zoneId, before.epochMilliseconds),
          );
          expect(
            Temporal.PlainDate.compare(todayFor(zoneId, before), day),
          ).toBe(-1);
        }),
      );
    },
    propertyTestTimeout(10_000),
  );
});

describe("todayFor (examples)", () => {
  test("00:30 in Prague is already the next day while UTC is not", () => {
    const at = Temporal.Instant.from("2026-03-31T22:30:00Z");
    expect(todayFor("Europe/Prague", at).toString()).toBe("2026-04-01");
    expect(todayFor("UTC", at).toString()).toBe("2026-03-31");
  });

  test("an unknown zone is refused rather than guessed", () => {
    expect(() => todayFor("Mars/Olympus_Mons")).toThrow(RangeError);
  });
});
