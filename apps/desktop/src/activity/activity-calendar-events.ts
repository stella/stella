import { panic } from "better-result";
import * as v from "valibot";

import {
  desktopCalendarEventsResponseSchema,
  type DesktopCalendarResponse,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";
import type { DayCalendarRange } from "@stll/ui/day-calendar.logic";

import type { TimedSegment } from "./activity-logic";

/** What `calendar_day_events` answers: the server's answer, or `off` when
 * the user has not turned calendar events on and nothing was read. */
const activityCalendarDaySchema = v.union([
  desktopCalendarEventsResponseSchema,
  v.strictObject({ status: v.literal("off") }),
]);
export type ActivityCalendarDay = v.InferOutput<
  typeof activityCalendarDaySchema
>;

/** The native answer, or `null` when it does not match the contract. */
export const parseActivityCalendarDay = (
  value: unknown,
): ActivityCalendarDay | null => {
  const parsed = v.safeParse(activityCalendarDaySchema, value);
  return parsed.success ? parsed.output : null;
};

/** A timed event as the day review draws it, cut to the day. */
export type CalendarEventBlock = DayCalendarRange & {
  id: string;
  title: string;
  response: DesktopCalendarResponse;
  /** Time inside the event that was recorded. The recording is the record
   * of it; the event only adds its title. */
  recordedMs: number;
};

export type CalendarAllDayEvent = {
  id: string;
  title: string;
  response: DesktopCalendarResponse;
};

export type CalendarEventLane = {
  timed: CalendarEventBlock[];
  allDay: CalendarAllDayEvent[];
};

/** The local day `date` in `timeZone`, as instants. */
export const calendarDayRange = (
  date: string,
  timeZone: string,
): DayCalendarRange => {
  const day = Temporal.PlainDate.from(date);
  return {
    startMs: day.toZonedDateTime({ timeZone }).epochMilliseconds,
    endMs: day.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds,
  };
};

/** Recorded ranges merged where they overlap: a call is recorded beside
 * whatever was in front, and that time counts once. */
const recordedRanges = (segments: readonly TimedSegment[]) => {
  const merged: DayCalendarRange[] = [];
  for (const { startMs, endMs } of segments.toSorted(
    (left, right) => left.startMs - right.startMs,
  )) {
    const last = merged.at(-1);
    if (last !== undefined && startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, endMs);
      continue;
    }
    merged.push({ startMs, endMs });
  }
  return merged;
};

const overlapMs = (left: DayCalendarRange, right: DayCalendarRange) =>
  Math.max(
    0,
    Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs),
  );

type CalendarEventLaneOptions = {
  day: ActivityCalendarDay;
  segments: readonly TimedSegment[];
  dayRange: DayCalendarRange;
};

/**
 * The events of a read day: timed ones cut to the day with how much of each
 * was recorded, and all-day ones apart. Nothing here is counted as time.
 */
export const calendarEventLane = ({
  day,
  segments,
  dayRange,
}: CalendarEventLaneOptions): CalendarEventLane => {
  if (day.status !== "ready") {
    return { timed: [], allDay: [] };
  }
  const recorded = recordedRanges(segments);
  const timed: CalendarEventBlock[] = [];
  const allDay: CalendarAllDayEvent[] = [];
  for (const [index, event] of day.events.entries()) {
    const id = `calendar:${String(index)}`;
    switch (event.timing) {
      case "allDay":
        allDay.push({ id, title: event.title, response: event.response });
        break;
      case "timed": {
        const range = {
          startMs: Math.max(
            Temporal.Instant.from(event.start).epochMilliseconds,
            dayRange.startMs,
          ),
          endMs: Math.min(
            Temporal.Instant.from(event.end).epochMilliseconds,
            dayRange.endMs,
          ),
        };
        if (range.endMs <= range.startMs) {
          break;
        }
        timed.push({
          ...range,
          id,
          title: event.title,
          response: event.response,
          recordedMs: recorded.reduce(
            (sum, part) => sum + overlapMs(range, part),
            0,
          ),
        });
        break;
      }
      default:
        event satisfies never;
        return panic("Unhandled calendar event timing");
    }
  }
  timed.sort((left, right) => left.startMs - right.startMs);
  return { timed, allDay };
};

/**
 * The title of the event a recorded call belongs to: the timed event that
 * overlaps the call longest, the earlier one on a tie; `null` when none
 * does or it has no title.
 */
export const callEventTitle = (
  call: DayCalendarRange,
  events: readonly CalendarEventBlock[],
): string | null => {
  let best: { overlap: number; title: string } | null = null;
  for (const event of events) {
    const overlap = overlapMs(call, event);
    if (overlap > 0 && (best === null || overlap > best.overlap)) {
      best = { overlap, title: event.title };
    }
  }
  return best === null || best.title.length === 0 ? null : best.title;
};
