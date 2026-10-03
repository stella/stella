import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  sourceStoredTotalNextRefreshAt,
  SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
} from "@/api/handlers/case-law/ingestion/source-totals";
import { toSafeId } from "@/api/lib/branded-types";

test("source phases stay stable across time and bound the next refresh", () => {
  assertProperty(
    "source phases stay stable across time and bound the next refresh",
    fc.property(
      fc.uuid(),
      fc.integer({ min: 0, max: 2_000_000_000_000 }),
      (id, time) => {
        const sourceId = toSafeId<"caseLawSource">(id);
        const first = sourceStoredTotalNextRefreshAt(sourceId, new Date(time));
        const later = sourceStoredTotalNextRefreshAt(
          sourceId,
          new Date(time + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
        );
        expect(first.getTime()).toBeGreaterThanOrEqual(time);
        expect(first.getTime()).toBeLessThan(
          time + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
        );
        expect(later.getTime() - first.getTime()).toBe(
          SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
        );
        expect(
          sourceStoredTotalNextRefreshAt(sourceId, new Date(time)),
        ).toEqual(first);
      },
    ),
  );
});

test("a hundred fixed sources do not cluster more than five counts into one minute", () => {
  const startedAt = new Date("2026-10-02T12:00:00Z");
  const windows = new Map<number, number>();
  for (let index = 0; index < 100; index += 1) {
    const sourceId = toSafeId<"caseLawSource">(
      `0199a111-1111-7111-8111-${index.toString(16).padStart(12, "0")}`,
    );
    const scheduled = sourceStoredTotalNextRefreshAt(sourceId, startedAt);
    const minute = Math.floor(
      (scheduled.getTime() - startedAt.getTime()) / 60_000,
    );
    windows.set(minute, (windows.get(minute) ?? 0) + 1);
  }
  expect(windows.size).toBeGreaterThan(50);
  expect(Math.max(...windows.values())).toBeLessThanOrEqual(5);
});

test("a successful slot's next future phase has a gap of at most one day", () => {
  assertProperty(
    "a successful slot's next future phase has a gap of at most one day",
    fc.property(
      fc.uuid(),
      fc.integer({ min: 0, max: 2_000_000_000_000 }),
      (id, time) => {
        const sourceId = toSafeId<"caseLawSource">(id);
        const next = sourceStoredTotalNextRefreshAt(
          sourceId,
          new Date(time + 1),
        );
        expect(next.getTime()).toBeGreaterThan(time);
        expect(next.getTime()).toBeLessThanOrEqual(
          time + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
        );
      },
    ),
  );
});

test("late successful refreshes return to their fixed source phase instead of shifting by a day", () => {
  assertProperty(
    "late successful refreshes return to their fixed source phase instead of shifting by a day",
    fc.property(
      fc.uuid(),
      fc.integer({ min: 0, max: 2_000_000_000_000 }),
      fc.integer({ min: 1, max: SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS - 1 }),
      (id, time, lateness) => {
        const sourceId = toSafeId<"caseLawSource">(id);
        const slot = sourceStoredTotalNextRefreshAt(sourceId, new Date(time));
        const claimedAt = slot.getTime() + lateness;
        const next = sourceStoredTotalNextRefreshAt(
          sourceId,
          new Date(claimedAt + 1),
        );
        expect(next.getTime()).toBe(
          slot.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
        );
        expect(next.getTime()).toBeLessThan(
          claimedAt + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
        );
      },
    ),
  );
});
