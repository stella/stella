import { describe, expect, test } from "bun:test";

import { getDisplayedWorkDate } from "@/features/inbox/my-work.logic";

describe("getDisplayedWorkDate", () => {
  test("shows the date responsible for an at-risk classification", () => {
    expect(
      getDisplayedWorkDate({
        attention: "working_target_due",
        hardDeadlineDate: "2026-09-30",
        workingTargetDate: "2026-09-20",
      }),
    ).toBe("2026-09-20");
    expect(
      getDisplayedWorkDate({
        attention: "hard_deadline_due",
        hardDeadlineDate: "2026-09-30",
        workingTargetDate: "2026-09-20",
      }),
    ).toBe("2026-09-30");
  });

  test("prefers the hard deadline for ordinary upcoming work", () => {
    expect(
      getDisplayedWorkDate({
        attention: "none",
        hardDeadlineDate: "2026-09-30",
        workingTargetDate: "2026-09-20",
      }),
    ).toBe("2026-09-30");
  });
});
