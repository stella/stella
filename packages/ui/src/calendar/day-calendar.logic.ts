import { panic, Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

export const DAY_CALENDAR_GRANULARITIES = [15, 30, 60] as const;

export type DayCalendarGranularity =
  (typeof DAY_CALENDAR_GRANULARITIES)[number];

/**
 * Height of one grid slot. Coarser grids get taller slots, but not
 * proportionally: an hour stays tall enough for a two-line block.
 */
export const DAY_CALENDAR_SLOT_HEIGHT_PX = {
  15: 22,
  30: 32,
  60: 44,
} as const satisfies Record<DayCalendarGranularity, number>;

/** A half-open instant range, `[startMs, endMs)`, in epoch milliseconds. */
export type DayCalendarRange = {
  endMs: number;
  startMs: number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const granularityMs = (granularity: DayCalendarGranularity): number =>
  granularity * MINUTE_MS;

type DayBoundsOptions = {
  date: string;
  endHour: number;
  startHour: number;
  timeZone: string;
};

/**
 * The instants a day view covers, from `startHour` to `endHour` wall-clock
 * time in `timeZone`. A daylight-saving day is an hour shorter or longer;
 * the view stays linear in real time. Hours wholly inside a daylight-saving
 * gap resolve both ends to the same instant; the view then covers the hour
 * after the gap rather than collapsing to zero height.
 */
export const getDayBounds = ({
  date,
  endHour,
  startHour,
  timeZone,
}: DayBoundsOptions): DayCalendarRange => {
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    endHour > 24 ||
    startHour >= endHour
  ) {
    panic("Day calendar hours must be whole hours with 0 <= start < end <= 24");
  }
  const plainDate = ISO_DATE_PATTERN.test(date)
    ? Result.try(() => Temporal.PlainDate.from(date)).unwrapOr(null)
    : null;
  if (plainDate === null) {
    panic("Day calendar dates must use normalized YYYY-MM-DD values");
  }
  const zonedStart = (day: Temporal.PlainDate, hour: number) =>
    day.toZonedDateTime({ plainTime: { hour }, timeZone }).epochMilliseconds;
  const startMs = zonedStart(plainDate, startHour);
  const endMs =
    endHour === 24
      ? zonedStart(plainDate.add({ days: 1 }), 0)
      : zonedStart(plainDate, endHour);
  return { endMs: endMs > startMs ? endMs : startMs + HOUR_MS, startMs };
};

/**
 * Whether the wall-clock time at `ms` occurs twice in `timeZone`, as in the
 * repeated hour of a fall-back day; only its UTC offset tells it apart from
 * its twin. A wall time read from an instant is never in a gap, so the two
 * resolutions differ only for a repeated one.
 */
export const isRepeatedWallTime = (ms: number, timeZone: string): boolean => {
  const wallTime = Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime();
  return (
    wallTime.toZonedDateTime(timeZone, { disambiguation: "earlier" })
      .epochMilliseconds !==
    wallTime.toZonedDateTime(timeZone, { disambiguation: "later" })
      .epochMilliseconds
  );
};

/** One instant per elapsed hour from the day's start, for hour labels. */
export const getHourTicks = (bounds: DayCalendarRange): number[] => {
  const ticks: number[] = [];
  for (let tick = bounds.startMs; tick < bounds.endMs; tick += HOUR_MS) {
    ticks.push(tick);
  }
  return ticks;
};

type OffsetOptions = {
  granularity: DayCalendarGranularity;
  bounds: DayCalendarRange;
};

export const timeToOffset = (
  ms: number,
  { granularity, bounds }: OffsetOptions,
): number =>
  ((ms - bounds.startMs) / granularityMs(granularity)) *
  DAY_CALENDAR_SLOT_HEIGHT_PX[granularity];

export const offsetToTime = (
  offsetPx: number,
  { granularity, bounds }: OffsetOptions,
): number =>
  bounds.startMs +
  (offsetPx / DAY_CALENDAR_SLOT_HEIGHT_PX[granularity]) *
    granularityMs(granularity);

export const boundsHeight = (options: OffsetOptions): number =>
  timeToOffset(options.bounds.endMs, options);

export const clampToBounds = (ms: number, bounds: DayCalendarRange): number =>
  Math.min(bounds.endMs, Math.max(bounds.startMs, ms));

export type SnapDirection = "ceil" | "floor" | "nearest";

const SNAP_ROUNDING = {
  ceil: Math.ceil,
  floor: Math.floor,
  nearest: Math.round,
} as const satisfies Record<SnapDirection, (value: number) => number>;

/**
 * Snaps to the slot grid, which starts at the day's first hour (a whole
 * wall-clock hour), then clamps into the day. Idempotent: a snapped
 * instant is a grid point or a day edge, and both snap to themselves.
 */
export const snapToGrid = (
  ms: number,
  {
    direction,
    granularity,
    bounds,
  }: OffsetOptions & { direction: SnapDirection },
): number => {
  const step = granularityMs(granularity);
  const slots = SNAP_ROUNDING[direction]((ms - bounds.startMs) / step);
  return clampToBounds(bounds.startMs + slots * step, bounds);
};

/**
 * Ensures a range spans at least one slot without leaving the day. A day
 * whose length is not a whole number of slots ends in a partial slot, so a
 * range ending at the day's end may be shorter than a slot; its start stays
 * on the grid.
 */
const atLeastOneSlot = (
  range: DayCalendarRange,
  options: OffsetOptions,
): DayCalendarRange => {
  const { bounds } = options;
  const step = granularityMs(options.granularity);
  const duration = range.endMs - range.startMs;
  if (duration >= step || (duration > 0 && range.endMs === bounds.endMs)) {
    return range;
  }
  if (range.startMs < bounds.endMs) {
    return {
      endMs: Math.min(bounds.endMs, range.startMs + step),
      startMs: range.startMs,
    };
  }
  // An empty range at the day's end takes the day's last slot.
  return {
    endMs: bounds.endMs,
    startMs: snapToGrid(bounds.endMs - step, { ...options, direction: "ceil" }),
  };
};

/**
 * The snapped range between a drag's anchor and the pointer, in either
 * order: the start floors and the end ceils, so the range always covers
 * both instants.
 */
export const rangeFromDrag = (
  { anchorMs, pointerMs }: { anchorMs: number; pointerMs: number },
  options: OffsetOptions,
): DayCalendarRange =>
  atLeastOneSlot(
    {
      endMs: snapToGrid(Math.max(anchorMs, pointerMs), {
        ...options,
        direction: "ceil",
      }),
      startMs: snapToGrid(Math.min(anchorMs, pointerMs), {
        ...options,
        direction: "floor",
      }),
    },
    options,
  );

/** Moves a range by whole slots, keeping its duration inside the day. */
export const moveRange = (
  range: DayCalendarRange,
  slots: number,
  { granularity, bounds }: OffsetOptions,
): DayCalendarRange => {
  const duration = range.endMs - range.startMs;
  const startMs = Math.min(
    bounds.endMs - duration,
    Math.max(
      bounds.startMs,
      range.startMs + slots * granularityMs(granularity),
    ),
  );
  return { endMs: startMs + duration, startMs };
};

/** Grows or shrinks a range's end by whole slots; it never drops below one slot. */
export const extendRange = (
  range: DayCalendarRange,
  slots: number,
  options: OffsetOptions,
): DayCalendarRange => {
  const step = granularityMs(options.granularity);
  const endMs = Math.min(
    options.bounds.endMs,
    Math.max(range.startMs + step, range.endMs + slots * step),
  );
  return atLeastOneSlot({ endMs, startMs: range.startMs }, options);
};

/** A one-slot range at the snapped instant, used to start a keyboard selection. */
export const slotAt = (ms: number, options: OffsetOptions): DayCalendarRange =>
  rangeFromDrag({ anchorMs: ms, pointerMs: ms }, options);

export type DayCalendarLanePlacement = {
  lane: number;
  laneCount: number;
};

/**
 * Places overlapping ranges side by side. Ranges that overlap transitively
 * form a cluster; each takes the first lane free at its start, and every
 * member of a cluster shares the cluster's lane count, so their widths match.
 */
export const layoutOverlaps = (
  ranges: readonly (DayCalendarRange & { id: string })[],
): Map<string, DayCalendarLanePlacement> => {
  const sorted = [...ranges].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      right.endMs - left.endMs ||
      compareIds(left.id, right.id),
  );
  const placements = new Map<string, DayCalendarLanePlacement>();
  const seen = new Set<string>();
  let cluster: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const closeCluster = () => {
    for (const { id, lane } of cluster) {
      placements.set(id, { lane, laneCount: laneEnds.length });
    }
    cluster = [];
    laneEnds = [];
  };

  for (const range of sorted) {
    if (seen.has(range.id)) {
      panic("Day calendar block ids must be unique within a column");
    }
    seen.add(range.id);
    if (range.startMs >= clusterEnd) {
      closeCluster();
    }
    const freeLane = laneEnds.findIndex((end) => end <= range.startMs);
    const lane = freeLane === -1 ? laneEnds.length : freeLane;
    laneEnds[lane] = range.endMs;
    cluster.push({ id: range.id, lane });
    clusterEnd = Math.max(clusterEnd, range.endMs);
  }
  closeCluster();
  return placements;
};

export type MergedSegment<Segment extends DayCalendarRange & { id: string }> =
  | { segment: Segment; type: "single" }
  | {
      endMs: number;
      id: string;
      sources: Segment[];
      startMs: number;
      type: "mixed";
    };

/**
 * Collapses runs of rapid switching. Consecutive segments shorter than
 * `thresholdMs` that touch or overlap form one `mixed` entry listing its
 * sources in time order; a lone short segment stays as it is. Every input
 * segment lands in exactly one output entry, and the time the output covers
 * equals the time the input covers. Output ids are unique: a `mixed` id
 * derives from its first source and takes a numeric suffix when an input or
 * an earlier entry already uses it.
 */
export const mergeShortSegments = <
  Segment extends DayCalendarRange & { id: string },
>(
  segments: readonly Segment[],
  { thresholdMs }: { thresholdMs: number },
): MergedSegment<Segment>[] => {
  const sorted = [...segments].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      compareIds(left.id, right.id),
  );
  const merged: MergedSegment<Segment>[] = [];
  const takenIds = new Set(segments.map(({ id }) => id));
  let run: Segment[] = [];
  let runEnd = Number.NEGATIVE_INFINITY;

  const mixedId = (first: Segment) => {
    const base = `mixed:${first.id}`;
    let id = base;
    for (let suffix = 2; takenIds.has(id); suffix += 1) {
      id = `${base}:${String(suffix)}`;
    }
    takenIds.add(id);
    return id;
  };

  const flushRun = () => {
    const first = run.at(0);
    if (first !== undefined && run.length === 1) {
      merged.push({ segment: first, type: "single" });
    }
    if (first !== undefined && run.length > 1) {
      merged.push({
        endMs: runEnd,
        id: mixedId(first),
        sources: run,
        startMs: first.startMs,
        type: "mixed",
      });
    }
    run = [];
    runEnd = Number.NEGATIVE_INFINITY;
  };

  for (const segment of sorted) {
    if (segment.endMs - segment.startMs >= thresholdMs) {
      flushRun();
      merged.push({ segment, type: "single" });
      continue;
    }
    if (segment.startMs > runEnd) {
      flushRun();
    }
    run.push(segment);
    runEnd = Math.max(runEnd, segment.endMs);
  }
  flushRun();
  return merged;
};

function compareIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
