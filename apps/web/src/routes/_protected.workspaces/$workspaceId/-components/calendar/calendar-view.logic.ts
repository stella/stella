import type { CalendarEntry } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-day-cell";
import {
  getMonthDays,
  getWeekDays,
  TASK_DATE_IDS,
} from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-utils";
import type { CalendarTask } from "@/routes/_protected.workspaces/$workspaceId/-queries/calendar-tasks";

export const toDayStartDateTime = (date: string): string =>
  new Date(`${date}T00:00:00.000Z`).toISOString();

const padDatePart = (value: number): string => String(value).padStart(2, "0");

const toUTCDateKey = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = padDatePart(date.getUTCMonth() + 1);
  const day = padDatePart(date.getUTCDate());

  return `${year}-${month}-${day}`;
};

const utcDateFromKey = (dateKey: string): Date | null => {
  const [yearPart, monthPart, dayPart] = dateKey.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day));
};

const toCalendarDayKey = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return toUTCDateKey(date);
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
    }
  | {
      type: "week";
      viewDate: Date;
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
        getMonthDays(input.year, input.month),
        fallback,
      );
    }
    case "week":
      return getBoundedCalendarRange(
        getWeekDays(input.viewDate),
        toUTCDateKey(input.viewDate),
      );
    default: {
      const exhaustive: never = input;
      return exhaustive;
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
        const current = utcDateFromKey(startDate);
        const end = utcDateFromKey(endDate);
        if (!current || !end) {
          continue;
        }

        while (current <= end) {
          appendToMapArray(map, toUTCDateKey(current), {
            entity,
            propertyId: propId,
          });
          current.setUTCDate(current.getUTCDate() + 1);
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
