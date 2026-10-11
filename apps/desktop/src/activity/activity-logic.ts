import { Temporal } from "@stll/time";

import type { ActivitySegment } from "./activity-types";

const MINUTE_MS = 60_000;
/** Active periods closer than this merge into one proposed block. */
export const BLOCK_GAP_MS = 10 * MINUTE_MS;
/** Proposed block durations round up to this increment (a tenth of an hour). */
const BLOCK_INCREMENT_MS = 6 * MINUTE_MS;
const TOP_APPS_PER_BLOCK = 3;
/** Shorter spans remain in the timeline and active total, without a proposal. */
export const MIN_PROPOSED_BLOCK_MS = 3 * MINUTE_MS;

export type TimedSegment = {
  appIdentifier: string;
  appName: string;
  document: string | null;
  windowTitle: string | null;
  endMs: number;
  startMs: number;
};

export type AppTotal = {
  durationMs: number;
  identifier: string;
  name: string;
};

export type ActivityBlock = {
  /** Apps by time spent inside the block, longest first. */
  apps: AppTotal[];
  document: string | null;
  windowTitles: string[];
  endMs: number;
  /** The block's span rounded up to whole increments: tenths of an hour. */
  roundedTenths: number;
  startMs: number;
};

/** Parsed, non-empty segments in chronological order. */
export const timedSegments = (
  segments: readonly ActivitySegment[],
): TimedSegment[] =>
  segments
    .map(({ appIdentifier, appName, document, windowTitle, end, start }) => ({
      appIdentifier,
      appName,
      document: document ?? null,
      windowTitle: windowTitle ?? null,
      endMs: Temporal.Instant.from(end).epochMilliseconds,
      startMs: Temporal.Instant.from(start).epochMilliseconds,
    }))
    .filter(({ endMs, startMs }) => endMs > startMs)
    .sort((left, right) => left.startMs - right.startMs);

export const totalDurationMs = (segments: readonly TimedSegment[]) =>
  segments.reduce(
    (total, segment) => total + segment.endMs - segment.startMs,
    0,
  );

export const appTotals = (segments: readonly TimedSegment[]): AppTotal[] => {
  const totals = new Map<string, AppTotal>();
  for (const segment of segments) {
    const duration = segment.endMs - segment.startMs;
    const existing = totals.get(segment.appIdentifier);
    if (existing) {
      existing.durationMs += duration;
      continue;
    }
    totals.set(segment.appIdentifier, {
      durationMs: duration,
      identifier: segment.appIdentifier,
      name: segment.appName,
    });
  }
  return [...totals.values()].sort(
    (left, right) =>
      right.durationMs - left.durationMs || left.name.localeCompare(right.name),
  );
};

export const roundedTenthsOfHour = (durationMs: number) =>
  Math.ceil(Math.max(0, durationMs) / BLOCK_INCREMENT_MS);

/** Same-document activity merged across short gaps; no-document activity groups together. */
export const proposeBlocks = (
  segments: readonly TimedSegment[],
): ActivityBlock[] => {
  const groups: TimedSegment[][] = [];
  let groupEndMs = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    const current = groups.at(-1);
    if (
      current &&
      current.at(0)?.document === segment.document &&
      segment.startMs - groupEndMs < BLOCK_GAP_MS
    ) {
      current.push(segment);
    } else {
      groups.push([segment]);
      groupEndMs = segment.endMs;
      continue;
    }
    groupEndMs = Math.max(groupEndMs, segment.endMs);
  }
  return groups.flatMap((group) => {
    const first = group.at(0);
    if (!first) {
      return [];
    }
    const endMs = Math.max(...group.map((segment) => segment.endMs));
    if (endMs - first.startMs < MIN_PROPOSED_BLOCK_MS) {
      return [];
    }
    return [
      {
        document: first.document,
        windowTitles: [
          ...new Set(
            group.flatMap(({ windowTitle }) =>
              windowTitle ? [windowTitle] : [],
            ),
          ),
        ],
        apps: appTotals(group),
        endMs,
        roundedTenths: roundedTenthsOfHour(endMs - first.startMs),
        startMs: first.startMs,
      },
    ];
  });
};

export const topAppNames = (block: ActivityBlock) =>
  block.apps.slice(0, TOP_APPS_PER_BLOCK).map((app) => app.name);

/** A `YYYY-MM-DD` calendar date moved by whole days. */
export const shiftDate = (date: string, days: number) =>
  Temporal.PlainDate.from(date).add({ days }).toString();

/** Local noon of a `YYYY-MM-DD` date in epoch milliseconds, safe to format
 *  as that day. */
export const calendarDate = (date: string) =>
  Temporal.PlainDate.from(date).toZonedDateTime({
    plainTime: "12:00",
    timeZone: Temporal.Now.timeZoneId(),
  }).epochMilliseconds;

export type DurationParts = { hours: number; minutes: number };

/** Whole hours and minutes, rounding to the nearest minute. */
export const durationParts = (durationMs: number): DurationParts => {
  const totalMinutes = Math.round(Math.max(0, durationMs) / MINUTE_MS);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
};

/** Native document metadata is a local path; separators can come from either platform. */
export const documentName = (document: string) =>
  document.split(/[\\/]/u).findLast((part) => part.length > 0) ?? "";
