import { describe, expect, test } from "bun:test";

import { getDisplayedWorkDate } from "./-task-row.logic";

describe("Todos displayed work date", () => {
  test("shows the working target when it caused the attention state", () => {
    expect(
      getDisplayedWorkDate({
        attention: "working_target_due",
        hardDeadlineDate: "2026-09-01",
        workingTargetDate: "2026-08-01",
      }),
    ).toBe("2026-08-01");
  });

  test("shows the hard deadline when it caused the attention state", () => {
    expect(
      getDisplayedWorkDate({
        attention: "hard_deadline_due",
        hardDeadlineDate: "2026-08-01",
        workingTargetDate: "2026-07-15",
      }),
    ).toBe("2026-08-01");
  });

  test("otherwise prefers the hard deadline", () => {
    expect(
      getDisplayedWorkDate({
        attention: "none",
        hardDeadlineDate: "2026-09-01",
        workingTargetDate: "2026-08-15",
      }),
    ).toBe("2026-09-01");
  });
});
