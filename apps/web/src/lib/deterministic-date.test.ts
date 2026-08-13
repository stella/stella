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
});
