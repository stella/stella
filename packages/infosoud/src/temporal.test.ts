import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import { parseInfoSoudDate, parseInfoSoudDateTime } from "./temporal.js";

const epochMilliseconds = (value: string): number =>
  Temporal.Instant.from(value).epochMilliseconds;

describe("parseInfoSoudDate", () => {
  test("normalizes both source grammars to the same leap day", () => {
    const expected = {
      isoDate: "2024-02-29",
      unixMs: epochMilliseconds("2024-02-29T00:00:00Z"),
    };

    expect(parseInfoSoudDate("29.2.2024")).toEqual({
      ...expected,
      raw: "29.2.2024",
    });
    expect(parseInfoSoudDate("2024-02-29")).toEqual({
      ...expected,
      raw: "2024-02-29",
    });
  });

  test("rejects calendar rollover instead of constraining it", () => {
    for (const raw of ["29.2.1900", "31.4.2025", "2025-02-29"]) {
      expect(parseInfoSoudDate(raw)).toEqual({
        isoDate: null,
        raw,
        unixMs: null,
      });
    }
  });
});

describe("parseInfoSoudDateTime", () => {
  test("converts Czech summer wall times to the correct UTC instant", () => {
    expect(parseInfoSoudDateTime("15.04.2025 08:30")).toEqual({
      isoDateTime: "2025-04-15T08:30:00",
      raw: "15.04.2025 08:30",
      unixMs: epochMilliseconds("2025-04-15T06:30:00Z"),
    });
  });

  test("converts Czech winter wall times to the correct UTC instant", () => {
    expect(parseInfoSoudDateTime("15.01.2025 08:30")).toEqual({
      isoDateTime: "2025-01-15T08:30:00",
      raw: "15.01.2025 08:30",
      unixMs: epochMilliseconds("2025-01-15T07:30:00Z"),
    });
  });

  test("rejects a wall time skipped by the Prague spring transition", () => {
    expect(parseInfoSoudDateTime("30.03.2025 02:30")).toEqual({
      isoDateTime: null,
      raw: "30.03.2025 02:30",
      unixMs: null,
    });
  });

  test("chooses the later instant during the repeated Prague autumn hour", () => {
    expect(parseInfoSoudDateTime("26.10.2025 02:30:45")).toEqual({
      isoDateTime: "2025-10-26T02:30:45",
      raw: "26.10.2025 02:30:45",
      unixMs: epochMilliseconds("2025-10-26T01:30:45Z"),
    });
  });
});
