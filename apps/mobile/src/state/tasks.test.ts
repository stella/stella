import { describe, expect, test } from "bun:test";
import { Temporal } from "temporal-polyfill/full";

import type { TaskSummary } from "./tasks";
import { dayAt, dueOf, groupByDue } from "./tasks";

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
});
