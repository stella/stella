import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  aggregateProfileSchema,
  allocateWorkspaceRows,
  createColumnSlots,
  createSeededRandom,
  PLACEHOLDER_PROFILE,
} from "./profile";

test("workspace allocations conserve counts and reproduce skew without populating zero buckets", () => {
  assertProperty(
    "workspace allocations conserve counts and reproduce skew without populating zero buckets",
    fc.property(
      fc.integer({ min: 0, max: 0xff_ff_ff_ff }),
      fc.integer({ min: 100_000, max: 1_000_000 }),
      (seed, rowCount) => {
        const histogram =
          PLACEHOLDER_PROFILE.tables.entities.workspaceHistogram;
        const allocate = () =>
          allocateWorkspaceRows({
            histogram,
            rowCount,
            random: createSeededRandom(seed),
          });
        const rows = allocate();
        expect(rows).toEqual(allocate());
        expect(rows.reduce((sum, count) => sum + count, 0)).toBe(rowCount);
        expect(rows.length).toBe(
          Object.values(histogram).reduce((sum, count) => sum + count, 0),
        );
        expect(
          rows.slice(0, histogram["0"]).every((count) => count === 0),
        ).toBe(true);
        expect(
          rows.every((count) => Number.isSafeInteger(count) && count >= 0),
        ).toBe(true);
        expect(rows.at(-1)).toBeGreaterThan(
          Math.max(
            ...rows.slice(histogram["0"], histogram["0"] + histogram["1-10"]),
          ),
        );
      },
    ),
    { numRuns: 100 },
  );
});

test("column slots conserve null and common-value frequencies across seeds", () => {
  assertProperty(
    "column slots conserve null and common-value frequencies across seeds",
    fc.property(
      fc.integer({ min: 0, max: 0xff_ff_ff_ff }),
      fc.integer({ min: 100, max: 2000 }),
      (seed, rowCount) => {
        const stats = {
          null_frac: 0.15,
          n_distinct: 12,
          most_common_freqs: [0.4, 0.2],
          avg_width: 8,
        };
        const build = () =>
          createColumnSlots({
            stats,
            rowCount,
            random: createSeededRandom(seed),
          });
        const slots = build();
        const again = build();
        const counts = new Map<number | null, number>();
        for (let index = 0; index < rowCount; index++) {
          const slot = slots.slotAt(index);
          expect(slot).toBe(again.slotAt(index));
          counts.set(slot, (counts.get(slot) ?? 0) + 1);
        }
        expect(counts.get(null)).toBe(slots.nullCount);
        expect(
          Math.abs(slots.nullCount - rowCount * stats.null_frac),
        ).toBeLessThanOrEqual(1);
        for (const [index, count] of slots.mcvCounts.entries()) {
          expect(counts.get(index)).toBe(count);
          expect(
            Math.abs(
              count - rowCount * (stats.most_common_freqs.at(index) ?? 0),
            ),
          ).toBeLessThanOrEqual(1);
        }
        expect(counts.size - 1).toBe(slots.distinctCount);
      },
    ),
    { numRuns: 50 },
  );
});

test("negative distinct estimates scale with row count while positive estimates stay absolute", () => {
  for (const rowCount of [100, 1000, 10_000]) {
    const stats = {
      null_frac: 0,
      n_distinct: -0.5,
      most_common_freqs: [],
      avg_width: 8,
    };
    const relative = createColumnSlots({
      stats,
      rowCount,
      random: createSeededRandom(12),
    });
    const absolute = createColumnSlots({
      stats: { ...stats, n_distinct: 12 },
      rowCount,
      random: createSeededRandom(12),
    });
    expect(relative.distinctCount).toBe(rowCount / 2);
    expect(absolute.distinctCount).toBe(12);
    expect(
      new Set(
        Array.from({ length: rowCount }, (_, index) => relative.slotAt(index)),
      ).size,
    ).toBe(relative.distinctCount);
  }
});

test("empty and entirely null distributions have no synthetic values", () => {
  const stats = {
    null_frac: 1,
    n_distinct: 0,
    most_common_freqs: [],
    avg_width: 0,
  };
  for (const rowCount of [0, 1, 100]) {
    const slots = createColumnSlots({
      stats,
      rowCount,
      random: createSeededRandom(0),
    });
    expect(slots.distinctCount).toBe(0);
    expect(slots.nullCount).toBe(rowCount);
    expect(
      Array.from({ length: rowCount }, (_, index) => slots.slotAt(index)).every(
        (value) => value === null,
      ),
    ).toBe(true);
  }
});

test("aggregate validation rejects values, impossible frequencies and inconsistent tenancy", () => {
  expect(v.safeParse(aggregateProfileSchema, PLACEHOLDER_PROFILE).success).toBe(
    true,
  );
  for (const averageRowWidth of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
  ]) {
    expect(
      v.safeParse(aggregateProfileSchema, {
        ...PLACEHOLDER_PROFILE,
        tables: {
          ...PLACEHOLDER_PROFILE.tables,
          entities: { ...PLACEHOLDER_PROFILE.tables.entities, averageRowWidth },
        },
      }).success,
    ).toBe(false);
  }
  const invalidColumn = (column: object) => ({
    ...PLACEHOLDER_PROFILE,
    tables: {
      ...PLACEHOLDER_PROFILE.tables,
      entities: {
        ...PLACEHOLDER_PROFILE.tables.entities,
        columns: { kind: column },
      },
    },
  });
  const valid = PLACEHOLDER_PROFILE.tables.entities.columns.kind;
  for (const column of [
    { ...valid, most_common_vals: ["private-value"] },
    { ...valid, null_frac: -0.1 },
    { ...valid, n_distinct: -1.1 },
    { ...valid, most_common_freqs: [0.8, 0.4] },
    { ...valid, avg_width: Number.NaN },
  ]) {
    expect(
      v.safeParse(aggregateProfileSchema, invalidColumn(column)).success,
    ).toBe(false);
  }
  const missingBucket = {
    ...PLACEHOLDER_PROFILE.tables.entities.workspaceHistogram,
    "0": -1,
  };
  expect(
    v.safeParse(aggregateProfileSchema, {
      ...PLACEHOLDER_PROFILE,
      tables: {
        ...PLACEHOLDER_PROFILE.tables,
        entities: {
          ...PLACEHOLDER_PROFILE.tables.entities,
          workspaceHistogram: missingBucket,
        },
      },
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(aggregateProfileSchema, {
      ...PLACEHOLDER_PROFILE,
      tables: {
        ...PLACEHOLDER_PROFILE.tables,
        entities: {
          ...PLACEHOLDER_PROFILE.tables.entities,
          workspaceHistogram: { ...missingBucket, "0": 21 },
        },
      },
    }).success,
  ).toBe(false);
});
