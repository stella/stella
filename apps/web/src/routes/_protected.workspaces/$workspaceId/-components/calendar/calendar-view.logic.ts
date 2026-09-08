import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import type { CalendarTask } from "@/lib/workspaces/queries/calendar-tasks";
import type { CalendarEntry } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-day-cell";
import {
  getMonthDays,
  getWeekDays,
  TASK_DATE_IDS,
} from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-utils";

export const toDayStartDateTime = (date: string): string =>
  Temporal.PlainDate.from(date)
    .toZonedDateTime({
      plainTime: Temporal.PlainTime.from("00:00"),
      timeZone: "UTC",
    })
    .toInstant()
    .toString({ fractionalSecondDigits: 3 });

const toUTCDateKey = (date: Temporal.PlainDate): string => date.toString();

const utcDateFromKey = (dateKey: string): Temporal.PlainDate | null => {
  return Result.try(() => Temporal.PlainDate.from(dateKey)).unwrapOr(null);
};

const toCalendarDayKey = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return Result.try(() => Temporal.PlainDate.from(value).toString()).unwrapOr(
      null,
    );
  }
  return Result.try(() =>
    Temporal.Instant.from(value)
      .toZonedDateTimeISO("UTC")
      .toPlainDate()
      .toString(),
  ).unwrapOr(null);
};

export const getCalendarTaskDate = (
  task: CalendarTask,
  propertyId: string,
): string | null => {
  if (propertyId === "_created-at") {
    return toCalendarDayKey(task.createdAt);
  }
  if (propertyId === "_updated-at") {
    return toCalendarDayKey(task.updatedAt);
  }
  if (propertyId === TASK_DATE_IDS[0]) {
    return toCalendarDayKey(task.dueDate);
  }
  if (propertyId === TASK_DATE_IDS[1]) {
    const value = task.startAt ?? task.occurredAt ?? task.dueDate;
    return toCalendarDayKey(value);
  }

  const field = task.fields.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  if (field?.content.type === "date" && field.content.value) {
    return toCalendarDayKey(field.content.value);
  }

  return null;
};

type CalendarQueryRangeInput =
  | {
      type: "month";
      year: number;
      month: number;
      firstWeekday: number;
      weekend: ReadonlySet<number>;
    }
  | {
      type: "week";
      viewDate: Temporal.PlainDate;
      firstWeekday: number;
      weekend: ReadonlySet<number>;
    }
  | {
      type: "year";
      year: number;
    };

export const getCalendarQueryRange = (
  input: CalendarQueryRangeInput,
): { dateFrom: string; dateTo: string } => {
  switch (input.type) {
    case "year":
      return getBoundedCalendarRange(
        [{ date: `${input.year}-01-01` }, { date: `${input.year}-12-31` }],
        `${input.year}-01-01`,
      );
    case "month": {
      const fallback = `${input.year}-${String(input.month + 1).padStart(2, "0")}-01`;
      return getBoundedCalendarRange(
        getMonthDays(
          input.year,
          input.month,
          input.firstWeekday,
          input.weekend,
        ),
        fallback,
      );
    }
    case "week":
      return getBoundedCalendarRange(
        getWeekDays(input.viewDate, input.firstWeekday, input.weekend),
        toUTCDateKey(input.viewDate),
      );
    default: {
      input satisfies never;
      return panic(`Unhandled input: ${String(input)}`);
    }
  }
};

const getBoundedCalendarRange = (
  days: readonly { date: string }[],
  fallbackDate: string,
): { dateFrom: string; dateTo: string } => ({
  dateFrom: toDayStartDateTime(days.at(0)?.date ?? fallbackDate),
  dateTo: toDayStartDateTime(days.at(-1)?.date ?? fallbackDate),
});

type GroupCalendarTasksInput = {
  tasks: readonly CalendarTask[];
  datePropertyIds: readonly string[];
  datePropertyId: string;
  endDatePropertyId?: string | undefined;
};

export const groupCalendarTasksByDate = ({
  tasks,
  datePropertyIds,
  datePropertyId,
  endDatePropertyId,
}: GroupCalendarTasksInput): Map<string, CalendarEntry[]> => {
  const map = new Map<string, CalendarEntry[]>();

  for (const entity of tasks) {
    for (const propId of datePropertyIds) {
      const startDate = getCalendarTaskDate(entity, propId);
      if (!startDate) {
        continue;
      }

      const endDate =
        propId === datePropertyId && endDatePropertyId
          ? getCalendarTaskDate(entity, endDatePropertyId)
          : null;

      if (endDate && endDate > startDate) {
        let current = utcDateFromKey(startDate);
        const end = utcDateFromKey(endDate);
        if (!current || !end) {
          continue;
        }

        while (Temporal.PlainDate.compare(current, end) <= 0) {
          appendToMapArray(map, toUTCDateKey(current), {
            entity,
            propertyId: propId,
          });
          current = addUTCDays(current, 1);
        }
      } else {
        appendToMapArray(map, startDate, { entity, propertyId: propId });
      }
    }
  }

  return map;
};

const appendToMapArray = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }

  map.set(key, [value]);
};

const addUTCDays = (
  date: Temporal.PlainDate,
  days: number,
): Temporal.PlainDate => date.add({ days });
