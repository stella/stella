import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import type { PickerClock } from "./picked-day";
import { MATERIAL_CLOCK, pickedDay, pickerDate } from "./picked-day";

const device = (timeZone: string): PickerClock => ({
  timeZone,
  plainTime: "12:00",
});

const at = (iso: string) =>
  new Date(Temporal.Instant.from(iso).epochMilliseconds);

describe("pickedDay", () => {
  test("reads a SwiftUI day in the device's zone, at any time of it", () => {
    const prague = device("Europe/Prague");
    expect(pickedDay(at("2026-11-05T23:00:00Z"), prague)).toBe("2026-11-06");
    expect(pickedDay(at("2026-11-06T22:59:59Z"), prague)).toBe("2026-11-06");
    expect(pickedDay(at("2026-11-06T23:00:00Z"), prague)).toBe("2026-11-07");
  });

  test("reads the same instant as different days on either side of the date line", () => {
    const instant = at("2026-11-06T09:00:00Z");
    expect(pickedDay(instant, device("Pacific/Kiritimati"))).toBe("2026-11-06");
    expect(pickedDay(instant, device("Pacific/Pago_Pago"))).toBe("2026-11-05");
  });

  test("reads a Material day as its midnight UTC", () => {
    expect(pickedDay(at("2026-11-06T00:00:00Z"), MATERIAL_CLOCK)).toBe(
      "2026-11-06",
    );
    expect(pickedDay(at("2027-01-03T00:00:00Z"), MATERIAL_CLOCK)).toBe(
      "2027-01-03",
    );
  });
});

describe("pickerDate", () => {
  test("round-trips every day of a year through every clock", () => {
    const clocks = [
      MATERIAL_CLOCK,
      device("Europe/Prague"),
      device("America/Los_Angeles"),
      device("Pacific/Kiritimati"),
      device("Pacific/Pago_Pago"),
    ];
    let day = Temporal.PlainDate.from("2028-01-01");
    while (day.year === 2028) {
      for (const clock of clocks) {
        expect(pickedDay(pickerDate(day.toString(), clock), clock)).toBe(
          day.toString(),
        );
      }
      day = day.add({ days: 1 });
    }
  });

  test("puts a device day at its local noon, also on a daylight-saving change", () => {
    const date = pickerDate("2026-03-29", device("Europe/Prague"));
    expect(date.toISOString()).toBe("2026-03-29T10:00:00.000Z");
  });

  test("puts a Material day at its midnight UTC", () => {
    expect(pickerDate("2026-11-06", MATERIAL_CLOCK).toISOString()).toBe(
      "2026-11-06T00:00:00.000Z",
    );
  });
});
