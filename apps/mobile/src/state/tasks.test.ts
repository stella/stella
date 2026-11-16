import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import { TASK_STATUS, TASK_STATUSES } from "@stll/api-contract/entity-options";

import { ApiRequestError } from "./api-request";
import type { TaskSummary, TasksView } from "./tasks";
import {
  applyTasksPage,
  dayAt,
  dueOf,
  groupByDue,
  isTaskClosed,
  nextTaskStatus,
  NO_TASKS_LOADED,
  tasksQuery,
} from "./tasks";

const TODAY = Temporal.PlainDate.from("2026-10-28");

const task = (id: string, dueDate?: string): TaskSummary => ({
  id,
  name: `Task ${id}`,
  matterId: "m1",
  matterName: "Matter",
  ...(dueDate === undefined ? {} : { dueDate }),
});

describe("a task's due date", () => {
  test("is read in the person's time zone", () => {
    // 23:30 in Prague is already the next day in Tokyo.
    const at = Temporal.ZonedDateTime.from(
      "2026-10-28T23:30[Europe/Prague]",
    ).epochMilliseconds;
    expect(dayAt(at, "Europe/Prague").toString()).toBe("2026-10-28");
    expect(dayAt(at, "Asia/Tokyo").toString()).toBe("2026-10-29");
  });

  test("falls overdue, today, tomorrow, this week or later", () => {
    expect(dueOf("2026-10-27", TODAY)).toBe("overdue");
    expect(dueOf("2026-10-28", TODAY)).toBe("today");
    expect(dueOf("2026-10-29", TODAY)).toBe("tomorrow");
    expect(dueOf("2026-11-04", TODAY)).toBe("week");
    expect(dueOf("2026-11-05", TODAY)).toBe("later");
    expect(dueOf(null, TODAY)).toBe("none");
  });
});

describe("tasks by due date", () => {
  test("groups in due order, keeping the server's order within each", () => {
    const groups = groupByDue(
      [
        task("1"),
        task("2", "2026-11-20"),
        task("3", "2026-10-20"),
        task("4", "2026-10-28"),
        task("5", "2026-10-01"),
      ],
      TODAY,
    );
    expect(
      groups.map(({ due, data }) => [due, data.map(({ id }) => id)]),
    ).toEqual([
      ["overdue", ["3", "5"]],
      ["today", ["4"]],
      ["later", ["2"]],
      ["none", ["1"]],
    ]);
  });

  test("a finished task goes last, however long past its date", () => {
    const groups = groupByDue(
      [
        { ...task("1", "2026-10-01"), status: TASK_STATUS.DONE },
        { ...task("2", "2026-10-01"), status: TASK_STATUS.IN_REVIEW },
        { ...task("3"), status: TASK_STATUS.CANCELLED },
      ],
      TODAY,
    );
    expect(
      groups.map(({ due, data }) => [due, data.map(({ id }) => id)]),
    ).toEqual([
      ["overdue", ["2"]],
      ["closed", ["1", "3"]],
    ]);
  });
});

describe("a tasks list's query", () => {
  const read = (view: TasksView, cursor: string | null = null) =>
    Object.fromEntries(new URLSearchParams(tasksQuery(view, TODAY, cursor)));

  test("the person's own open tasks by default, a page at a time", () => {
    expect(read({ whose: "mine", show: "open" })).toEqual({
      limit: "100",
      assignee: "me",
    });
  });

  test("whose maps onto the server's assignee filter", () => {
    expect(read({ whose: "everyone", show: "open" })["assignee"]).toBe("any");
    expect(read({ whose: "unassigned", show: "open" })["assignee"]).toBe(
      "unassigned",
    );
  });

  test("overdue is open and due before today; all keeps finished ones", () => {
    expect(read({ whose: "mine", show: "overdue" })).toEqual({
      limit: "100",
      assignee: "me",
      dateTo: "2026-10-27",
    });
    expect(read({ whose: "mine", show: "all" })["openOnly"]).toBe("false");
  });

  test("one matter's list names it, and a next page its cursor", () => {
    expect(
      read({ whose: "everyone", show: "open", matterId: "matter-1" }, "c1"),
    ).toEqual({
      limit: "100",
      assignee: "any",
      matterId: "matter-1",
      cursor: "c1",
    });
  });
});

describe("a tasks list's pages", () => {
  const PAGE = { items: [task("1"), task("2")], nextCursor: "c1" };

  test("a page appends to the ones before, keeping the first page's day", () => {
    const first = applyTasksPage(NO_TASKS_LOADED, Result.ok(PAGE), 10);
    const second = applyTasksPage(
      first,
      Result.ok({ items: [task("3")], nextCursor: null }),
      20,
    );
    expect(second).toEqual({
      loadedAt: 10,
      tasks: [task("1"), task("2"), task("3")],
      nextCursor: null,
      error: null,
    });
  });

  test("a next page that fails keeps what loaded, with why", () => {
    const first = applyTasksPage(NO_TASKS_LOADED, Result.ok(PAGE), 10);
    const error = new ApiRequestError({ message: "offline" });
    expect(applyTasksPage(first, Result.err(error), 20)).toEqual({
      ...first,
      error,
    });
  });
});

describe("a task's one-step status change", () => {
  test.each(TASK_STATUSES)(
    "from %s crosses between open and finished",
    (status) => {
      const next = nextTaskStatus(status);
      expect(isTaskClosed(next)).toBe(!isTaskClosed(status));
      expect(isTaskClosed(nextTaskStatus(next))).toBe(isTaskClosed(status));
    },
  );

  test("finishes as done and reopens as open", () => {
    expect(nextTaskStatus(TASK_STATUS.IN_REVIEW)).toBe(TASK_STATUS.DONE);
    expect(nextTaskStatus(TASK_STATUS.CANCELLED)).toBe(TASK_STATUS.OPEN);
  });

  test("treats a status the app does not know as open", () => {
    expect(nextTaskStatus("waiting_on_client")).toBe(TASK_STATUS.DONE);
  });
});
