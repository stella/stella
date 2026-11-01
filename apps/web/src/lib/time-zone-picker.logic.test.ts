import { describe, expect, test } from "bun:test";

import { matchesTimeZone, timeZoneOptions } from "@/lib/time-zone-picker.logic";
import { jurisdictionTimeZones } from "@/lib/timezones";

const REFERENCE_INSTANT = new Date("2026-01-15T12:00:00.000Z");

const options = timeZoneOptions({
  zones: ["UTC", "Europe/Prague", "America/New_York"],
  browserZone: "America/New_York",
  jurisdictionZones: ["Europe/Prague", "UTC"],
  selectedZone: "Asia/Tokyo",
  follow: {
    value: "follow-primary",
    label: "Follow primary jurisdiction",
    zone: "Europe/Prague",
  },
  now: REFERENCE_INSTANT,
});

const matchingValues = (query: string) =>
  options
    .filter((option) => matchesTimeZone(option, query))
    .map(({ value }) => value);

describe("time zone options", () => {
  test("keeps a saved zone this browser does not know, without an offset", () => {
    const [unknown] = timeZoneOptions({
      zones: [],
      browserZone: "Mars/Olympus_Mons",
      jurisdictionZones: [],
      selectedZone: "Mars/Olympus_Mons",
      now: REFERENCE_INSTANT,
    });
    expect(unknown).toEqual({
      value: "Mars/Olympus_Mons",
      label: "Mars/Olympus Mons",
      offset: "",
    });
  });

  test("reads each offset at the supplied instant", () => {
    const offsetAt = (now: Date) =>
      timeZoneOptions({
        zones: [],
        browserZone: "Europe/Prague",
        jurisdictionZones: [],
        selectedZone: "Europe/Prague",
        now,
      }).at(0)?.offset;
    expect(offsetAt(REFERENCE_INSTANT)).toBe("UTC+01:00");
    expect(offsetAt(new Date("2026-07-15T12:00:00.000Z"))).toBe("UTC+02:00");
  });

  test("search matches city labels, regions, raw ids, and offsets", () => {
    expect(matchingValues("Prague")).toEqual(["Europe/Prague"]);
    expect(matchingValues("Europe")).toEqual(["Europe/Prague"]);
    expect(matchingValues("America/New_York")).toEqual(["America/New_York"]);
    expect(matchingValues("+01:00")).toEqual([
      "follow-primary",
      "Europe/Prague",
    ]);
  });

  test("pins follow, browser, jurisdiction, selected, and all zones without duplicates", () => {
    expect(options.map(({ value }) => value)).toEqual([
      "follow-primary",
      "America/New_York",
      "Europe/Prague",
      "UTC",
      "Asia/Tokyo",
    ]);
    expect(new Set(options.map(({ value }) => value)).size).toBe(
      options.length,
    );
    expect(options.find(({ value }) => value === "Europe/Prague")?.offset).toBe(
      "UTC+01:00",
    );
  });

  test("offsets reflect daylight saving and fractional-hour zones at the supplied instant", () => {
    const summer = timeZoneOptions({
      zones: ["Europe/Prague", "Asia/Kathmandu"],
      browserZone: "UTC",
      jurisdictionZones: [],
      selectedZone: "UTC",
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(summer.find(({ value }) => value === "Europe/Prague")?.offset).toBe(
      "UTC+02:00",
    );
    expect(summer.find(({ value }) => value === "Asia/Kathmandu")?.offset).toBe(
      "UTC+05:45",
    );
  });
});

describe("jurisdiction time zones", () => {
  test("returns no pins when the runtime lacks Intl.Locale#getTimeZones", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Intl.Locale.prototype,
      "getTimeZones",
    );
    Reflect.deleteProperty(Intl.Locale.prototype, "getTimeZones");
    try {
      expect(jurisdictionTimeZones("CZ")).toEqual([]);
    } finally {
      if (descriptor) {
        Object.defineProperty(
          Intl.Locale.prototype,
          "getTimeZones",
          descriptor,
        );
      }
    }
  });
});
