import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { parsePgTimestampCursorValue } from "@/api/lib/db-pagination";

const cursorTimestamp = (date: Date, microseconds: number): string =>
  `${date.toISOString().slice(0, 19)}.${microseconds.toString().padStart(6, "0")}`;

describe("PostgreSQL timestamp cursor values", () => {
  test("INVARIANT: valid microsecond values round-trip without precision loss", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2099-12-31T23:59:59.999Z"),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 999_999 }),
        (date, microseconds) => {
          const value = cursorTimestamp(date, microseconds);
          expect(parsePgTimestampCursorValue(value)).toEqual({
            type: "pgTimestampCursor",
            value,
          });
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("keeps already-issued ISO cursor values readable", () => {
    const value = "2026-07-10T08:15:30.123Z";
    expect(parsePgTimestampCursorValue(value)).toEqual({
      type: "pgTimestampCursor",
      value,
    });
  });

  test("rejects non-canonical timestamp values", () => {
    for (const value of [
      "2026-07-10T08:15:30.12345",
      "2026-07-10T08:15:30.123456Z",
      "2026-13-10T08:15:30.123456",
      "2026-07-10 08:15:30.123456",
      "not-a-timestamp",
    ]) {
      expect(parsePgTimestampCursorValue(value)).toBeNull();
    }
  });
});
