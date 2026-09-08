import { panic, Result } from "better-result";

import { parsePlainDate, Temporal } from "@stll/time";

import { getFormattingLocale } from "@/i18n/i18n-store";
import { getFirstWeekday } from "@/i18n/week";
import type {
  DateFilter,
  LeadFilter,
  MattersFilters,
  NumericFilter,
  Workspace,
} from "@/lib/workspaces/types";

export const parseLocalISODateMs = (value: string): number =>
  parsePlainDate(value)?.toZonedDateTime(Temporal.Now.timeZoneId())
    .epochMilliseconds ?? Number.NaN;

const addLocalCalendarDaysMs = (value: number, days: number): number => {
  return Result.try(
    () =>
      Temporal.Instant.fromEpochMilliseconds(value)
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .add({ days })
        .toInstant().epochMilliseconds,
  ).unwrapOr(Number.NaN);
};

const toEpochMilliseconds = (value: Date | string): number =>
  value instanceof Date
    ? value.getTime()
    : Result.try(() => {
        if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
          return Temporal.PlainDate.from(value)
            .toZonedDateTime({
              plainTime: Temporal.PlainTime.from("00:00"),
              timeZone: "UTC",
            })
            .toInstant().epochMilliseconds;
        }
        return Temporal.Instant.from(value).epochMilliseconds;
      }).unwrapOr(Number.NaN);

type FilterableWorkspace = {
  client: Pick<NonNullable<Workspace["client"]>, "id"> | null;
  createdAt: Workspace["createdAt"];
  entityCount: number;
  lastActivityAt: Workspace["lastActivityAt"];
  leadUserId: string | null;
  members: readonly { userId: string }[];
};

/** Resolve a DateFilter to a closed-open `[from, to)` epoch range. */
const resolveDateRange = (
  filter: DateFilter,
  now: Date | Temporal.Instant = Temporal.Now.instant(),
): { fromMs: number; toMs: number } | null => {
  const timeZone = Temporal.Now.timeZoneId();
  const nowZoned = (
    now instanceof Date
      ? Temporal.Instant.fromEpochMilliseconds(now.getTime())
      : now
  ).toZonedDateTimeISO(timeZone);
  const startOfDay = (d: Temporal.ZonedDateTime): number =>
    d
      .with({
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        microsecond: 0,
        nanosecond: 0,
      })
      .toInstant().epochMilliseconds;
  const todayStart = startOfDay(nowZoned);

  switch (filter.preset) {
    case "today":
      return {
        fromMs: todayStart,
        toMs: addLocalCalendarDaysMs(todayStart, 1),
      };
    case "last7d":
      return {
        fromMs: addLocalCalendarDaysMs(todayStart, -6),
        toMs: addLocalCalendarDaysMs(todayStart, 1),
      };
    case "last30d":
      return {
        fromMs: addLocalCalendarDaysMs(todayStart, -29),
        toMs: addLocalCalendarDaysMs(todayStart, 1),
      };
    case "thisWeek": {
      // Week start follows the active locale's first weekday.
      const day = nowZoned.dayOfWeek % 7; // 0=Sun..6=Sat
      const firstWeekday = getFirstWeekday(getFormattingLocale());
      const sinceStart = (day - firstWeekday + 7) % 7;
      return {
        fromMs: addLocalCalendarDaysMs(todayStart, -sinceStart),
        toMs: addLocalCalendarDaysMs(todayStart, 7 - sinceStart),
      };
    }
    case "thisMonth": {
      const monthStartDate = nowZoned.toPlainDate().with({ day: 1 });
      const monthStart = monthStartDate
        .toZonedDateTime({
          plainTime: Temporal.PlainTime.from("00:00"),
          timeZone,
        })
        .toInstant().epochMilliseconds;
      const monthEnd = monthStartDate
        .add({ months: 1 })
        .toZonedDateTime({
          plainTime: Temporal.PlainTime.from("00:00"),
          timeZone,
        })
        .toInstant().epochMilliseconds;
      return { fromMs: monthStart, toMs: monthEnd };
    }
    case "custom": {
      if (!filter.from && !filter.to) {
        return null;
      }
      // `from`/`to` are `YYYY-MM-DD` local-date strings (inclusive).
      const fromMs = filter.from
        ? parseLocalISODateMs(filter.from)
        : Number.NEGATIVE_INFINITY;
      const toMs = filter.to
        ? addLocalCalendarDaysMs(parseLocalISODateMs(filter.to), 1)
        : Number.POSITIVE_INFINITY;
      return { fromMs, toMs };
    }
    default: {
      filter.preset satisfies never;
      return panic(`Unhandled preset: ${String(filter.preset)}`);
    }
  }
};

const passesDateFilter = (
  value: Date | string,
  filter: DateFilter,
  now: Date | Temporal.Instant,
): boolean => {
  const range = resolveDateRange(filter, now);
  if (!range) {
    return true;
  }
  const ts = toEpochMilliseconds(value);
  return ts >= range.fromMs && ts < range.toMs;
};

const passesNumericFilter = (value: number, filter: NumericFilter): boolean => {
  if (filter.gte !== undefined && value < filter.gte) {
    return false;
  }
  if (filter.lte !== undefined && value > filter.lte) {
    return false;
  }
  return true;
};

const passesLeadFilter = (
  workspace: Pick<FilterableWorkspace, "leadUserId">,
  filter: LeadFilter,
): boolean => {
  switch (filter.type) {
    case "any":
      return workspace.leadUserId !== null;
    case "none":
      return workspace.leadUserId === null;
    case "user":
      return workspace.leadUserId === filter.userId;
    default: {
      filter satisfies never;
      return panic(`Unhandled filter: ${String(filter)}`);
    }
  }
};

export const isMattersFiltersActive = (filters: MattersFilters): boolean =>
  filters.lastActivityAt !== undefined ||
  filters.createdAt !== undefined ||
  filters.client !== undefined ||
  filters.team !== undefined ||
  filters.lead !== undefined ||
  filters.entityCount !== undefined;

export const applyMattersFilters = <TWorkspace extends FilterableWorkspace>(
  workspaces: readonly TWorkspace[],
  filters: MattersFilters,
  now: Date | Temporal.Instant = Temporal.Now.instant(),
): TWorkspace[] => {
  if (!isMattersFiltersActive(filters)) {
    return [...workspaces];
  }
  return workspaces.filter((w) => {
    if (
      filters.lastActivityAt &&
      !passesDateFilter(w.lastActivityAt, filters.lastActivityAt, now)
    ) {
      return false;
    }
    if (
      filters.createdAt &&
      !passesDateFilter(w.createdAt, filters.createdAt, now)
    ) {
      return false;
    }
    if (
      filters.client &&
      filters.client.length > 0 &&
      (!w.client || !filters.client.includes(w.client.id))
    ) {
      return false;
    }
    if (filters.team && filters.team.length > 0) {
      const memberIds = new Set(w.members.map((m) => m.userId));
      if (!filters.team.some((id) => memberIds.has(id))) {
        return false;
      }
    }
    if (filters.lead && !passesLeadFilter(w, filters.lead)) {
      return false;
    }
    if (
      filters.entityCount &&
      !passesNumericFilter(w.entityCount, filters.entityCount)
    ) {
      return false;
    }
    return true;
  });
};
