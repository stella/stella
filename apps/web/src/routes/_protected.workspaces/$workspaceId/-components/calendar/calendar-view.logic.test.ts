import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { CalendarTask } from "@/routes/_protected.workspaces/$workspaceId/-queries/calendar-tasks";

import {
  getCalendarVisibleRange,
  groupCalendarTasksByDate,
} from "./calendar-view.logic";

const baseTask = {
  taskId: toSafeId<"entity">("00000000-0000-4000-8000-000000000001"),
  name: "Draft SPA",
  status: "open",
  createdAt: "2026-05-01T10:00:00.000Z",
  updatedAt: null,
  dueDate: null,
  startAt: null,
  endAt: null,
  occurredAt: null,
  fields: [],
} satisfies CalendarTask;

describe("calendar view logic", () => {
  test("uses the visible day range for month and week modes", () => {
    const range = getCalendarVisibleRange({
      mode: "month",
      year: 2026,
      month: 4,
      days: [{ date: "2026-04-27" }, { date: "2026-06-07" }],
    });

    expect(range).toEqual({
      dateFrom: "2026-04-27T00:00:00.000Z",
      dateTo: "2026-06-07T00:00:00.000Z",
    });
  });

  test("uses the full year range for year mode", () => {
    const range = getCalendarVisibleRange({
      mode: "year",
      year: 2026,
      month: 4,
      days: [],
    });

    expect(range).toEqual({
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: "2026-12-31T00:00:00.000Z",
    });
  });

  test("groups tasks by built-in and custom date properties", () => {
    const task2Id = toSafeId<"entity">("00000000-0000-4000-8000-000000000002");
    const tasks: CalendarTask[] = [
      { ...baseTask, dueDate: "2026-05-03" },
      {
        ...baseTask,
        taskId: task2Id,
        fields: [
          {
            id: toSafeId<"field">("00000000-0000-4000-8000-000000000003"),
            entityId: task2Id,
            propertyId: toSafeId<"property">(
              "00000000-0000-4000-8000-000000000004",
            ),
            content: { type: "date", version: 1, value: "2026-05-04" },
          },
        ],
      },
    ];

    const grouped = groupCalendarTasksByDate({
      tasks,
      datePropertyIds: ["_due-date", "00000000-0000-4000-8000-000000000004"],
      datePropertyId: "_due-date",
    });

    expect(
      grouped.get("2026-05-03")?.map((entry) => entry.entity.taskId),
    ).toEqual([baseTask.taskId]);
    expect(
      grouped.get("2026-05-04")?.map((entry) => entry.entity.taskId),
    ).toEqual([task2Id]);
  });

  test("spans primary date entries through configured end date", () => {
    const grouped = groupCalendarTasksByDate({
      tasks: [
        {
          ...baseTask,
          startAt: "2026-05-03T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:00.000Z",
        },
      ],
      datePropertyIds: ["_start-date"],
      datePropertyId: "_start-date",
      endDatePropertyId: "_updated-at",
    });

    expect([...grouped.keys()]).toEqual([
      "2026-05-03",
      "2026-05-04",
      "2026-05-05",
    ]);
  });
});
