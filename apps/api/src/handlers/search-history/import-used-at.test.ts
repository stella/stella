import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { LIMITS } from "@/api/lib/limits";

import { readImportClock, readImportUsedAt } from "./import-used-at";

const NOW = new Date("2026-01-02T03:04:05.000Z");

test("import times reject unrepresentable and future entries without clamping", () => {
  const clock =
    readImportClock(NOW.toISOString(), NOW) ?? panic("Expected fixture clock");
  for (const value of [
    "-005000-01-01T00:00:00Z",
    "-004713-11-23T23:59:59.999Z",
    "+294277-01-01T00:00:00Z",
    "invalid",
  ]) {
    expect(readImportUsedAt(value, clock)).toBeNull();
  }
  expect(
    readImportUsedAt("-004713-11-24T00:00:00Z", clock)?.toISOString(),
  ).toBe("-004713-11-24T00:00:00.000Z");
  expect(readImportUsedAt("2020-01-01T00:00:00Z", clock)?.toISOString()).toBe(
    "2020-01-01T00:00:00.000Z",
  );
  expect(readImportUsedAt("2027-01-01T00:00:00Z", clock)).toBeNull();
  expect(readImportUsedAt("2026-01-02T03:04:05.000000001Z", clock)).toBeNull();
  expect(readImportUsedAt(NOW.toISOString(), clock)).toEqual(NOW);
});

test("clock correction preserves entry age for clocks ahead and behind", () => {
  assertProperty(
    "clock correction preserves entry age for clocks ahead and behind",
    fc.property(
      fc.integer({
        min: -LIMITS.searchHistoryClockSkewMaxMs,
        max: LIMITS.searchHistoryClockSkewMaxMs,
      }),
      fc.integer({ min: 0, max: 1_000_000_000 }),
      (skewMs, ageMs) => {
        const clientNow = new Date(NOW.getTime() + skewMs);
        const clock =
          readImportClock(clientNow.toISOString(), NOW) ??
          panic("Expected bounded fixture clock");
        const localUse = new Date(clientNow.getTime() - ageMs).toISOString();
        expect(readImportUsedAt(localUse, clock)).toEqual(
          new Date(NOW.getTime() - ageMs),
        );
        expect(
          readImportUsedAt(
            new Date(clientNow.getTime() + 1).toISOString(),
            clock,
          ),
        ).toBeNull();
      },
    ),
  );
});

test("import clock rejects malformed or unbounded clock offsets", () => {
  for (const value of [
    "invalid",
    "-005000-01-01T00:00:00Z",
    "+294277-01-01T00:00:00Z",
    new Date(
      NOW.getTime() + LIMITS.searchHistoryClockSkewMaxMs + 1,
    ).toISOString(),
    new Date(
      NOW.getTime() - LIMITS.searchHistoryClockSkewMaxMs - 1,
    ).toISOString(),
  ]) {
    expect(readImportClock(value, NOW)).toBeNull();
  }
  expect(readImportClock(NOW.toISOString(), new Date(Number.NaN))).toBeNull();
});

test("correction rejects entries shifted below PostgreSQL storage bounds", () => {
  const clock =
    readImportClock(
      new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
      NOW,
    ) ?? panic("Expected fixture clock");
  expect(readImportUsedAt("-004713-11-24T00:00:00Z", clock)).toBeNull();
});
