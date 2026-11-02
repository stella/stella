import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { isTimestampCasToken } from "./timestamp-cas";

test("a token names a real instant in the text form Postgres prints", () => {
  for (const token of [
    "2026-10-31 21:06:28.123456+01",
    "2026-10-31 21:06:28+00",
    "2024-02-29 00:00:00.5-05",
    "0001-01-01 00:00:00+00:19:32",
    "9999-12-31 23:59:59.999999+14",
    "2026-06-30 12:00:00+05:30",
  ]) {
    expect({ token, accepted: isTimestampCasToken(token) }).toEqual({
      token,
      accepted: true,
    });
  }
});

test("a token with a date or time no calendar has is never a revision", () => {
  for (const token of [
    "2026-02-29 10:00:00+00",
    "2100-02-29 10:00:00+00",
    "2026-02-30 10:00:00.123456+00",
    "2026-04-31 10:00:00+00",
    "2026-13-01 10:00:00+00",
    "2026-00-10 10:00:00+00",
    "2026-10-00 10:00:00+00",
    "0000-01-01 00:00:00+00",
    "2026-10-31 24:00:00+00",
    "2026-10-31 23:60:00+00",
    "2026-10-31 23:59:60+00",
    "2026-10-31 10:00:00+16",
    "2026-10-31 10:00:00+05:60",
    "2026-10-31 10:00:00+05:30:60",
    "2026-10-31T10:00:00+00",
    "2026-10-31 10:00:00",
    "not a revision",
  ]) {
    expect({ token, accepted: isTimestampCasToken(token) }).toEqual({
      token,
      accepted: false,
    });
  }
});

test("every instant's printed form is accepted", () => {
  assertProperty(
    "every instant's printed form is accepted",
    fc.property(
      fc.date({
        min: new Date("0001-01-01T00:00:00.000Z"),
        max: new Date("9999-12-31T23:59:59.999Z"),
        noInvalidDate: true,
      }),
      fc.integer({ min: -15 * 60, max: 15 * 60 }),
      (date, offsetMinutes) => {
        const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
        const iso = shifted.toISOString();
        // Postgres prints years outside 1..9999 in another form.
        if (!/^(?!0000)\d{4}-/u.test(iso)) {
          return;
        }
        const sign = offsetMinutes < 0 ? "-" : "+";
        const hours = String(Math.trunc(Math.abs(offsetMinutes) / 60));
        const minutes = String(Math.abs(offsetMinutes) % 60);
        const token = `${iso.slice(0, 10)} ${iso.slice(11, 23)}${sign}${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
        expect(isTimestampCasToken(token)).toBe(true);
      },
    ),
  );
});
