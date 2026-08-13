import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parseDeterministicDate } from "./deterministic-date";

let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
});

afterEach(() => {
  process.env.TZ = originalTz ?? "";
});

describe("parseDeterministicDate", () => {
  test("parses date-only and explicitly zoned values identically across hosts", () => {
    process.env.TZ = "Pacific/Honolulu";
    const west = [
      parseDeterministicDate("2026-08-13")?.getTime(),
      parseDeterministicDate("2026-08-13T12:00:00+02:00")?.getTime(),
    ];
    process.env.TZ = "Pacific/Auckland";
    expect([
      parseDeterministicDate("2026-08-13")?.getTime(),
      parseDeterministicDate("2026-08-13T12:00:00+02:00")?.getTime(),
    ]).toEqual(west);
  });

  test("rejects time-zone-less datetimes", () => {
    expect(parseDeterministicDate("2026-08-13T12:00:00")).toBeNull();
    expect(parseDeterministicDate("not-a-date")).toBeNull();
  });

  test("rejects invalid calendar fields without allowing normalization", () => {
    for (const year of [1900, 2000, 2024, 2026]) {
      for (let monthNumber = 1; monthNumber <= 12; monthNumber += 1) {
        const finalDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
        const month = String(monthNumber).padStart(2, "0");
        const impossibleDate = `${year}-${month}-${finalDay + 1}`;
        expect(parseDeterministicDate(impossibleDate)).toBeNull();
        expect(
          parseDeterministicDate(`${impossibleDate}T12:00:00Z`),
        ).toBeNull();
        expect(
          parseDeterministicDate(`${impossibleDate}T12:00:00+02:00`),
        ).toBeNull();
      }
    }

    expect(parseDeterministicDate("2026-00-01")).toBeNull();
    expect(parseDeterministicDate("2026-13-01")).toBeNull();
    expect(parseDeterministicDate("2024-02-29")?.toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });
});
