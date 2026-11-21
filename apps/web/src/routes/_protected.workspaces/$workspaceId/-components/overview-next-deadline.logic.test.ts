import { describe, expect, test } from "bun:test";

import { resolveNextDeadline } from "./overview-next-deadline.logic";

const TODAY = "2026-11-01";

describe("the next deadline on the overview", () => {
  test("flags a deadline already missed", () => {
    const missed = { dueDate: "2026-10-20" };
    expect(
      resolveNextDeadline([missed, { dueDate: "2026-11-06" }], TODAY),
    ).toEqual({ dueDate: "2026-10-20", task: missed, type: "overdue" });
  });

  test("treats a deadline due today as still upcoming", () => {
    const dueToday = { dueDate: TODAY };
    expect(resolveNextDeadline([dueToday], TODAY)).toEqual({
      dueDate: TODAY,
      task: dueToday,
      type: "upcoming",
    });
  });

  test("skips undated tasks and reports none when no task has a date", () => {
    const dated = { dueDate: "2026-11-06" };
    expect(resolveNextDeadline([{ dueDate: null }, dated], TODAY)).toEqual({
      dueDate: "2026-11-06",
      task: dated,
      type: "upcoming",
    });
    expect(resolveNextDeadline([{ dueDate: null }], TODAY)).toEqual({
      type: "none",
    });
  });
});
