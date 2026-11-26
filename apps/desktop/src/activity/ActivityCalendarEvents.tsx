import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import type { DesktopCalendarResponse } from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import type {
  DayCalendarBlock,
  DayCalendarColumn,
} from "@stll/ui/day-calendar";
import { useExternalSyncEffect } from "@stll/ui/effects";

import type {
  ActivityCalendarDay,
  CalendarEventLane,
} from "./activity-calendar-events";
import {
  calendarDayRange,
  calendarEventLane,
  parseActivityCalendarDay,
} from "./activity-calendar-events";
import type { TimedSegment } from "./activity-logic";
import type {
  ActivityCalendarSource,
  ActivityDaySnapshot,
} from "./activity-types";
import { useDurationLabel } from "./use-duration-label";

const CALENDAR_COLUMN_ID = "calendar";

/** The day's calendar as the review knows it: not asked for (`off`), being
 * read, unreadable, or read. */
type CalendarDayState =
  | { type: "off" }
  | { type: "loading" }
  | { type: "failed" }
  | { type: "read"; day: ActivityCalendarDay };

type CalendarDayOptions = {
  date: string;
  timeZone: string;
  source: ActivityCalendarSource;
};

/**
 * Reads the shown day's events once per day, source and retry; never in the
 * background. An answer is kept under the request it answers, so a slow
 * answer for another day is never shown.
 */
function useCalendarDay({ date, timeZone, source }: CalendarDayOptions) {
  const [attempt, setAttempt] = useState(0);
  const requestKey = [date, timeZone, source, String(attempt)].join("\n");
  const [answer, setAnswer] = useState<{
    key: string;
    state: Extract<CalendarDayState, { type: "failed" | "read" }>;
  } | null>(null);
  useExternalSyncEffect(() => {
    if (source === "off") {
      return undefined;
    }
    let current = true;
    invoke("calendar_day_events", { date, timeZone })
      .then((value) => {
        if (current) {
          const day = parseActivityCalendarDay(value);
          setAnswer({
            key: requestKey,
            state: day === null ? { type: "failed" } : { type: "read", day },
          });
        }
        return undefined;
      })
      .catch(() => {
        if (current) {
          setAnswer({ key: requestKey, state: { type: "failed" } });
        }
      });
    return () => {
      current = false;
    };
  }, [date, timeZone, source, requestKey]);
  let state: CalendarDayState = { type: "loading" };
  if (source === "off") {
    state = { type: "off" };
  } else if (answer?.key === requestKey) {
    state = answer.state;
  }
  return { state, retry: () => setAttempt((count) => count + 1) };
}

const RESPONSE_KEYS = {
  organizer: "calendarResponseOrganizer",
  accepted: "calendarResponseAccepted",
  tentative: "calendarResponseTentative",
  notAnswered: "calendarResponseNotAnswered",
} as const satisfies Record<DesktopCalendarResponse, string>;

/** The Calendar lane: each timed event as an outline beside recorded time,
 * `null` while the user has calendar events off. */
function useCalendarColumn(
  state: CalendarDayState,
  lane: CalendarEventLane,
): DayCalendarColumn | null {
  const t = useTranslations("activity");
  const format = useFormatter();
  const durationLabel = useDurationLabel();
  const header = {
    id: CALENDAR_COLUMN_ID,
    label: t("calendarColumn"),
    width: "narrow",
  } as const;
  switch (state.type) {
    case "off":
      return null;
    case "loading":
      return { ...header, placeholders: [], type: "pending" };
    case "failed":
    case "read":
      break;
    default:
      state satisfies never;
      return panic("Unhandled calendar day state");
  }
  const blocks = lane.timed.map((event): DayCalendarBlock => {
    const range = format.dateTimeRange(event.startMs, event.endMs, {
      hour: "numeric",
      minute: "2-digit",
    });
    const title =
      event.title.length > 0 ? event.title : t("calendarEventUntitled");
    return {
      accessibleLabel: t("calendarEventLabel", { title, range }),
      caption: range,
      endMs: event.endMs,
      id: event.id,
      kind: "scheduled",
      startMs: event.startMs,
      title: <bdi>{title}</bdi>,
      tone: { type: "neutral" },
      tooltip: {
        type: "text",
        content: (
          <div className="flex w-64 flex-col gap-1 py-0.5 text-xs">
            <p className="font-medium">
              <bdi>{title}</bdi>
            </p>
            <p className="text-muted-foreground tabular-nums">{range}</p>
            <p>{t(RESPONSE_KEYS[event.response])}</p>
            <p>
              {event.recordedMs > 0
                ? t("calendarEventRecorded", {
                    duration: durationLabel(event.recordedMs),
                  })
                : t("calendarEventNothingRecorded")}
            </p>
            <p className="text-muted-foreground">
              {t("calendarEventNotCounted")}
            </p>
          </div>
        ),
      },
    };
  });
  return {
    ...header,
    blocks,
    rangeSelection: { type: "disabled" },
    type: "blocks",
  };
}

/** The shown day's calendar events in the reader's time zone: what was
 * read, the lane drawn beside Activity, and the instants the grid must keep
 * in view. */
export function useDayCalendarEvents(
  {
    date,
    calendarSource,
  }: Pick<ActivityDaySnapshot, "calendarSource" | "date">,
  segments: readonly TimedSegment[],
) {
  const timeZone = Temporal.Now.timeZoneId();
  const { state, retry } = useCalendarDay({
    date,
    timeZone,
    source: calendarSource,
  });
  const lane = calendarEventLane({
    day: state.type === "read" ? state.day : { status: "off" },
    segments,
    dayRange: calendarDayRange(date, timeZone),
  });
  const column = useCalendarColumn(state, lane);
  return {
    state,
    retry,
    lane,
    column,
    instants: lane.timed.flatMap(({ startMs, endMs }) => [startMs, endMs]),
  };
}

const STATUS_KEYS = {
  turnedOff: "calendarTurnedOff",
  notConnected: "calendarNotConnected",
  needsReconnect: "calendarNeedsReconnect",
} as const;

/** What the lane cannot show: why the calendar was not read, events that
 * fill the whole day, and a day cut at the read limit. */
export const CalendarEventsNotice = ({
  calendar: { state, lane, retry },
}: {
  calendar: ReturnType<typeof useDayCalendarEvents>;
}) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  switch (state.type) {
    case "off":
    case "loading":
      return null;
    case "failed":
      return (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          {t("calendarFailed")}
          <Button size="sm" variant="ghost" onClick={retry}>
            {t("retry")}
          </Button>
        </div>
      );
    case "read":
      break;
    default:
      state satisfies never;
      return panic("Unhandled calendar day state");
  }
  const { day } = state;
  switch (day.status) {
    case "off":
      return null;
    case "turnedOff":
    case "notConnected":
    case "needsReconnect":
      return (
        <p className="text-muted-foreground text-sm">
          {t(STATUS_KEYS[day.status])}
        </p>
      );
    case "ready":
      break;
    default:
      day satisfies never;
      return panic("Unhandled calendar day status");
  }
  if (lane.allDay.length === 0 && !day.truncated) {
    return null;
  }
  return (
    <div className="text-muted-foreground flex flex-col gap-1 text-sm">
      {lane.allDay.length === 0 ? null : (
        <p>
          {t("calendarAllDay", {
            events: format.list(
              lane.allDay.map(({ title }) =>
                title.length > 0 ? title : t("calendarEventUntitled"),
              ),
              { type: "unit" },
            ),
          })}
        </p>
      )}
      {day.truncated ? (
        <p>{t("calendarTruncated", { count: day.events.length })}</p>
      ) : null}
    </div>
  );
};
