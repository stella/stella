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
    "stored-total-source-phase-stability",
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

test("sources observed together occupy different refresh windows", () => {
  const startedAt = new Date("2026-10-02T12:00:00Z");
  const windows = new Set<number>();
  for (let index = 0; index < 100; index += 1) {
    const sourceId = toSafeId<"caseLawSource">(
      `0199a111-1111-7111-8111-${index.toString(16).padStart(12, "0")}`,
    );
    const scheduled = sourceStoredTotalNextRefreshAt(sourceId, startedAt);
    windows.add(
      Math.floor(
        (scheduled.getTime() - startedAt.getTime()) / (60 * 60 * 1000),
      ),
    );
  }
  expect(windows.size).toBe(6);
});
