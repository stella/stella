import { panic } from "better-result";

import { Temporal } from "@stll/time";

import type { ActivitySegment } from "./activity-types";

export const MINUTE_MS = 60_000;

export type TimedSegment = {
  appIdentifier: string;
  appName: string;
  document: string | null;
  windowTitle: string | null;
  matterId: string | null;
  call: boolean;
  endMs: number;
  startMs: number;
};

export type AppTotal = {
  durationMs: number;
  identifier: string;
  name: string;
};

/** Parsed, non-empty segments in chronological order. */
export const timedSegments = (
  segments: readonly ActivitySegment[],
): TimedSegment[] =>
  segments
    .map(
      ({
        appIdentifier,
        appName,
        document,
        windowTitle,
        matterId,
        call,
        end,
        start,
      }) => ({
        appIdentifier,
        appName,
        document: document ?? null,
        windowTitle: windowTitle ?? null,
        matterId: matterId ?? null,
        call: call ?? false,
        endMs: Temporal.Instant.from(end).epochMilliseconds,
        startMs: Temporal.Instant.from(start).epochMilliseconds,
      }),
    )
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

/** Whole numbers, one per value, that add up to `total`: each value is
 * rounded down, then the largest remainders take what is left, earlier
 * values first on a tie. `total` lies between the values' rounded-down sum
 * and that sum plus one per value. */
export const apportionWhole = (
  values: readonly number[],
  total: number,
): number[] => {
  const floors = values.map((value) => Math.floor(value));
  let left = total - floors.reduce((sum, value) => sum + value, 0);
  if (!Number.isInteger(total) || left < 0 || left > values.length) {
    return panic("Apportioned total is outside the values' rounding range");
  }
  const byRemainder = values
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort(
      (first, second) =>
        second.remainder - first.remainder || first.index - second.index,
    );
  for (const { index } of byRemainder) {
    if (left <= 0) {
      break;
    }
    floors[index] = (floors[index] ?? 0) + 1;
    left -= 1;
  }
  return floors;
};

/** Whole minutes for each recorded duration, together never more than the
 * minutes recorded in all of them: each rounds down, and the minutes the
 * total still holds go to the largest remainders. */
export const recordedMinutes = (durationsMs: readonly number[]): number[] =>
  apportionWhole(
    durationsMs.map((durationMs) => durationMs / MINUTE_MS),
    Math.floor(
      durationsMs.reduce((sum, durationMs) => sum + durationMs, 0) / MINUTE_MS,
    ),
  );

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
