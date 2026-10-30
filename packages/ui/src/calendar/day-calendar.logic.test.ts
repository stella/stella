import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  DAY_CALENDAR_GRANULARITIES,
  extendRange,
  getDayBounds,
  getHourTicks,
  granularityMs,
  layoutOverlaps,
  mergeShortSegments,
  moveRange,
  offsetToTime,
  rangeFromDrag,
  snapToGrid,
  timeToOffset,
} from "./day-calendar.logic";
import type { DayCalendarRange } from "./day-calendar.logic";

const HOUR_MS = 3_600_000;
const TIME_ZONE = "Europe/Prague";

// Prague's autumn day has 25 hours and its spring day 23, so the grid crosses
// a UTC-offset change; Lord Howe Island shifts by half an hour, so its spring
// day (23.5 hours) is not a whole number of hour slots. An ordinary day keeps
// the plain case covered.
const BOUNDS_DAYS = [
  { date: "2026-10-25", timeZone: TIME_ZONE },
  { date: "2026-10-30", timeZone: TIME_ZONE },
  { date: "2026-03-29", timeZone: TIME_ZONE },
  { date: "2026-10-04", timeZone: "Australia/Lord_Howe" },
] as const;

const boundsArbitrary = fc
  .record({
    day: fc.constantFrom(...BOUNDS_DAYS),
    endHour: fc.integer({ max: 24, min: 1 }),
    startHour: fc.integer({ max: 23, min: 0 }),
  })
  .filter(({ endHour, startHour }) => startHour < endHour)
  .map(({ day: { date, timeZone }, endHour, startHour }) =>
    getDayBounds({ date, endHour, startHour, timeZone }),
  );

const gridArbitrary = fc.record({
  bounds: boundsArbitrary,
  granularity: fc.constantFrom(...DAY_CALENDAR_GRANULARITIES),
});

const instantNear = (bounds: DayCalendarRange) =>
  fc.integer({ max: bounds.endMs + HOUR_MS, min: bounds.startMs - HOUR_MS });

const isOnGridOrEdge = (
  ms: number,
  {
    bounds,
    granularity,
  }: { bounds: DayCalendarRange; granularity: 15 | 30 | 60 },
) =>
  (ms - bounds.startMs) % granularityMs(granularity) === 0 ||
  ms === bounds.endMs;

describe("day calendar bounds", () => {
  test("follows the wall clock across daylight-saving changes", () => {
    const longDay = getDayBounds({
      date: "2026-10-25",
      endHour: 24,
      startHour: 0,
      timeZone: TIME_ZONE,
    });
    const shortDay = getDayBounds({
      date: "2026-03-29",
      endHour: 24,
      startHour: 0,
      timeZone: TIME_ZONE,
    });

    expect(longDay.endMs - longDay.startMs).toBe(25 * HOUR_MS);
    expect(getHourTicks(longDay)).toHaveLength(25);
    expect(shortDay.endMs - shortDay.startMs).toBe(23 * HOUR_MS);
    expect(new Date(longDay.startMs).toISOString()).toBe(
      "2026-10-24T22:00:00.000Z",
    );
  });

  test("keeps an hour when the hours fall inside a daylight-saving gap", () => {
    // 02:00-03:00 does not exist on 2026-03-29 in Prague; both ends resolve
    // to 03:00 CEST, so the view covers the hour after the gap.
    const gap = getDayBounds({
      date: "2026-03-29",
      endHour: 3,
      startHour: 2,
      timeZone: TIME_ZONE,
    });

    expect(new Date(gap.startMs).toISOString()).toBe(
      "2026-03-29T01:00:00.000Z",
    );
    expect(gap.endMs - gap.startMs).toBe(HOUR_MS);
    expect(getHourTicks(gap)).toEqual([gap.startMs]);
  });

  test("every pair of whole hours spans time on transition days", () => {
    for (const { date, timeZone } of BOUNDS_DAYS) {
      for (let startHour = 0; startHour < 24; startHour += 1) {
        for (let endHour = startHour + 1; endHour <= 24; endHour += 1) {
          const bounds = getDayBounds({ date, endHour, startHour, timeZone });
          expect(bounds.endMs).toBeGreaterThan(bounds.startMs);
        }
      }
    }
  });

  test("rejects hours outside a day", () => {
    expect(() =>
      getDayBounds({
        date: "2026-10-30",
        endHour: 25,
        startHour: 8,
        timeZone: TIME_ZONE,
      }),
    ).toThrow("Day calendar hours must be whole hours");
  });
});

describe("day calendar grid", () => {
  test("day calendar grid maps time to pixels and back", () => {
    assertProperty(
      "day calendar grid maps time to pixels and back",
      fc.property(
        gridArbitrary.chain((grid) =>
          fc.tuple(fc.constant(grid), instantNear(grid.bounds)),
        ),
        ([grid, ms]) => {
          expect(offsetToTime(timeToOffset(ms, grid), grid)).toBeCloseTo(ms, 3);
        },
      ),
    );
  });

  test("day calendar snapping is idempotent and stays inside the day", () => {
    assertProperty(
      "day calendar snapping is idempotent and stays inside the day",
      fc.property(
        gridArbitrary.chain((grid) =>
          fc.tuple(
            fc.constant(grid),
            instantNear(grid.bounds),
            fc.constantFrom("ceil", "floor", "nearest"),
            fc.constantFrom("ceil", "floor", "nearest"),
          ),
        ),
        ([grid, ms, direction, again]) => {
          const snapped = snapToGrid(ms, { ...grid, direction });

          expect(snapToGrid(snapped, { ...grid, direction: again })).toBe(
            snapped,
          );
          expect(snapped).toBeGreaterThanOrEqual(grid.bounds.startMs);
          expect(snapped).toBeLessThanOrEqual(grid.bounds.endMs);
          expect(isOnGridOrEdge(snapped, grid)).toBe(true);
        },
      ),
    );
  });

  test("day calendar drag yields a clamped snapped range covering both ends", () => {
    assertProperty(
      "day calendar drag yields a clamped snapped range covering both ends",
      fc.property(
        gridArbitrary.chain((grid) =>
          fc.tuple(
            fc.constant(grid),
            instantNear(grid.bounds),
            instantNear(grid.bounds),
          ),
        ),
        ([grid, anchorMs, pointerMs]) => {
          const { bounds } = grid;
          const range = rangeFromDrag({ anchorMs, pointerMs }, grid);
          const clamp = (ms: number) =>
            Math.min(bounds.endMs, Math.max(bounds.startMs, ms));

          expect(range.startMs).toBeGreaterThanOrEqual(bounds.startMs);
          expect(range.endMs).toBeLessThanOrEqual(bounds.endMs);
          // Only a range ending at the day's end may be a partial slot.
          expect(range.endMs - range.startMs).toBeGreaterThanOrEqual(
            range.endMs === bounds.endMs ? 1 : granularityMs(grid.granularity),
          );
          expect(isOnGridOrEdge(range.startMs, grid)).toBe(true);
          expect(isOnGridOrEdge(range.endMs, grid)).toBe(true);
          expect(range.startMs).toBeLessThanOrEqual(
            clamp(Math.min(anchorMs, pointerMs)),
          );
          expect(range.endMs).toBeGreaterThanOrEqual(
            clamp(Math.max(anchorMs, pointerMs)),
          );
          expect(
            rangeFromDrag({ anchorMs: pointerMs, pointerMs: anchorMs }, grid),
          ).toEqual(range);
        },
      ),
    );
  });

  test("a click in a day's final partial slot keeps the start on the grid", () => {
    // Lord Howe Island skips 02:00-02:30 on 2026-10-04: the day lasts 23.5
    // hours, so hour slots end in a half-hour slot.
    const bounds = getDayBounds({
      date: "2026-10-04",
      endHour: 24,
      startHour: 0,
      timeZone: "Australia/Lord_Howe",
    });
    const grid = { bounds, granularity: 60 } as const;
    const lastSlot = {
      endMs: bounds.endMs,
      startMs: bounds.startMs + 23 * HOUR_MS,
    };

    expect(bounds.endMs - bounds.startMs).toBe(23.5 * HOUR_MS);
    for (const clickMs of [
      bounds.startMs + 23.2 * HOUR_MS,
      bounds.endMs,
      bounds.endMs + HOUR_MS,
    ]) {
      expect(
        rangeFromDrag({ anchorMs: clickMs, pointerMs: clickMs }, grid),
      ).toEqual(lastSlot);
    }
  });

  test("day calendar keyboard moves keep the duration and the day", () => {
    assertProperty(
      "day calendar keyboard moves keep the duration and the day",
      fc.property(
        gridArbitrary.chain((grid) =>
          fc.tuple(
            fc.constant(grid),
            instantNear(grid.bounds),
            instantNear(grid.bounds),
            fc.integer({ max: 200, min: -200 }),
          ),
        ),
        ([grid, anchorMs, pointerMs, slots]) => {
          const range = rangeFromDrag({ anchorMs, pointerMs }, grid);
          const moved = moveRange(range, slots, grid);
          const extended = extendRange(range, slots, grid);

          expect(moved.endMs - moved.startMs).toBe(range.endMs - range.startMs);
          expect(moved.startMs).toBeGreaterThanOrEqual(grid.bounds.startMs);
          expect(moved.endMs).toBeLessThanOrEqual(grid.bounds.endMs);
          expect(extended.startMs).toBeGreaterThanOrEqual(grid.bounds.startMs);
          expect(extended.endMs).toBeLessThanOrEqual(grid.bounds.endMs);
          expect(extended.endMs).toBeGreaterThan(extended.startMs);
        },
      ),
    );
  });
});

type Segment = DayCalendarRange & { id: string };

// Activity arrives as consecutive segments: each starts where the previous
// ended, or after a gap.
// Ids come from a small pool that includes the shapes generated `mixed` ids
// take (`mixed:<id>`, `mixed:<id>:2`), so they can collide with input ids.
const segmentIdArbitrary = fc
  .tuple(
    fc.constantFrom("", "mixed:", "mixed:mixed:"),
    fc.integer({ max: 6, min: 0 }),
    fc.constantFrom("", ":2"),
  )
  .map(([prefix, index, suffix]) => `${prefix}s${String(index)}${suffix}`);

const segmentsArbitrary = fc
  .array(
    fc.record({
      durationMs: fc.integer({ max: 40 * 60_000, min: 1 }),
      gapMs: fc.oneof(fc.constant(0), fc.integer({ max: 10 * 60_000, min: 1 })),
    }),
    { maxLength: 40 },
  )
  .chain((steps) =>
    fc
      .uniqueArray(segmentIdArbitrary, {
        maxLength: steps.length,
        minLength: steps.length,
      })
      .map((ids) => ({ ids, steps })),
  )
  .map(({ ids, steps }) => {
    const segments: Segment[] = [];
    let cursor = 0;
    for (const [index, { durationMs, gapMs }] of steps.entries()) {
      const startMs = cursor + gapMs;
      const id = ids.at(index);
      if (id === undefined) {
        throw new Error("One id per segment");
      }
      segments.push({ endMs: startMs + durationMs, id, startMs });
      cursor = startMs + durationMs;
    }
    return segments;
  });

const coveredMs = (ranges: readonly DayCalendarRange[]): number => {
  const sorted = ranges.toSorted((left, right) => left.startMs - right.startMs);
  let total = 0;
  let coveredUntil = Number.NEGATIVE_INFINITY;
  for (const { endMs, startMs } of sorted) {
    const from = Math.max(startMs, coveredUntil);
    if (endMs > from) {
      total += endMs - from;
    }
    coveredUntil = Math.max(coveredUntil, endMs);
  }
  return total;
};

describe("day calendar segment merging", () => {
  test("day calendar merging conserves total duration and places every segment once", () => {
    assertProperty(
      "day calendar merging conserves total duration and places every segment once",
      fc.property(
        segmentsArbitrary,
        fc.integer({ max: 20 * 60_000, min: 1 }),
        (segments, thresholdMs) => {
          const merged = mergeShortSegments(segments, { thresholdMs });
          const outputRanges = merged.map((entry) =>
            entry.type === "single" ? entry.segment : entry,
          );
          const placedIds = merged.flatMap((entry) =>
            entry.type === "single"
              ? [entry.segment.id]
              : entry.sources.map(({ id }) => id),
          );
          const duration = (ranges: readonly DayCalendarRange[]) =>
            ranges.reduce(
              (sum, { endMs, startMs }) => sum + endMs - startMs,
              0,
            );

          expect(placedIds.toSorted()).toEqual(
            segments.map(({ id }) => id).toSorted(),
          );
          expect(duration(outputRanges)).toBe(duration(segments));
          expect(coveredMs(outputRanges)).toBe(coveredMs(segments));
          for (const entry of merged) {
            if (entry.type === "single") {
              continue;
            }
            expect(entry.sources.length).toBeGreaterThan(1);
            expect(
              entry.sources.every(
                ({ endMs, startMs }) => endMs - startMs < thresholdMs,
              ),
            ).toBe(true);
          }
        },
      ),
    );
  });

  test("day calendar merged entries have unique ids", () => {
    assertProperty(
      "day calendar merged entries have unique ids",
      fc.property(
        segmentsArbitrary,
        fc.integer({ max: 20 * 60_000, min: 1 }),
        (segments, thresholdMs) => {
          const entries = mergeShortSegments(segments, { thresholdMs }).map(
            (entry) => (entry.type === "single" ? entry.segment : entry),
          );

          expect(new Set(entries.map(({ id }) => id)).size).toBe(
            entries.length,
          );
          expect(layoutOverlaps(entries).size).toBe(entries.length);
        },
      ),
    );
  });

  test("a mixed id steps past an input id it would collide with", () => {
    const minute = 60_000;
    const merged = mergeShortSegments(
      [
        { endMs: minute, id: "a", startMs: 0 },
        { endMs: 2 * minute, id: "b", startMs: minute },
        { endMs: 11 * minute, id: "mixed:a", startMs: 10 * minute },
      ],
      { thresholdMs: 5 * minute },
    );

    expect(
      merged.map((entry) =>
        entry.type === "single" ? entry.segment.id : entry.id,
      ),
    ).toEqual(["mixed:a:2", "mixed:a"]);
  });

  test("lists the sources of a run of rapid switching", () => {
    const minute = 60_000;
    const merged = mergeShortSegments(
      [
        { endMs: 35 * minute, id: "editor", startMs: 0 },
        { endMs: 37 * minute, id: "terminal", startMs: 35 * minute },
        { endMs: 38 * minute, id: "browser", startMs: 37 * minute },
        { endMs: 40 * minute, id: "mail", startMs: 38 * minute },
        { endMs: 52 * minute, id: "lone", startMs: 50 * minute },
      ],
      { thresholdMs: 5 * minute },
    );

    expect(merged).toEqual([
      {
        segment: { endMs: 35 * minute, id: "editor", startMs: 0 },
        type: "single",
      },
      {
        endMs: 40 * minute,
        id: "mixed:terminal",
        sources: [
          { endMs: 37 * minute, id: "terminal", startMs: 35 * minute },
          { endMs: 38 * minute, id: "browser", startMs: 37 * minute },
          { endMs: 40 * minute, id: "mail", startMs: 38 * minute },
        ],
        startMs: 35 * minute,
        type: "mixed",
      },
      {
        segment: { endMs: 52 * minute, id: "lone", startMs: 50 * minute },
        type: "single",
      },
    ]);
  });
});

describe("day calendar overlap layout", () => {
  test("day calendar overlapping blocks never share a lane", () => {
    assertProperty(
      "day calendar overlapping blocks never share a lane",
      fc.property(
        fc.array(
          fc
            .record({
              durationMs: fc.integer({ max: 120, min: 1 }),
              startMs: fc.integer({ max: 600, min: 0 }),
            })
            .map(({ durationMs, startMs }) => ({
              endMs: startMs + durationMs,
              startMs,
            })),
          { maxLength: 30 },
        ),
        (ranges) => {
          const blocks = ranges.map((range, index) => ({
            ...range,
            id: `block-${String(index)}`,
          }));
          const lanes = layoutOverlaps(blocks);

          expect(lanes.size).toBe(blocks.length);
          for (const [index, left] of blocks.entries()) {
            const leftLane = lanes.get(left.id);
            expect(leftLane?.lane).toBeLessThan(leftLane?.laneCount ?? 0);
            for (const right of blocks.slice(index + 1)) {
              const overlaps =
                left.startMs < right.endMs && right.startMs < left.endMs;
              if (!overlaps) {
                continue;
              }
              const rightLane = lanes.get(right.id);
              expect(rightLane?.lane).not.toBe(leftLane?.lane);
              expect(rightLane?.laneCount).toBe(leftLane?.laneCount);
            }
          }
        },
      ),
    );
  });
});
