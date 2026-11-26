import { describe, expect, test } from "bun:test";

import { DEFAULT_TIME_POLICY, getTimePolicyViolation } from "./billing-time";

describe("time policy", () => {
  test("the edit window includes its cutoff and approvers can use older dates", () => {
    const input = {
      policy: DEFAULT_TIME_POLICY,
      today: "2024-03-01",
      canApprove: false,
    };
    expect(
      getTimePolicyViolation({ ...input, dateWorked: "2023-12-02" }),
    ).toBeNull();
    expect(
      getTimePolicyViolation({ ...input, dateWorked: "2023-12-01" })?.code,
    ).toBe("outside_edit_window");
    expect(
      getTimePolicyViolation({ ...input, dateWorked: "2024-03-02" })?.code,
    ).toBe("future_date_worked");
    expect(
      getTimePolicyViolation({ ...input, dateWorked: "2024-02-30" })?.code,
    ).toBe("invalid_date_worked");
    expect(
      getTimePolicyViolation({
        ...input,
        dateWorked: "2023-12-01",
        canApprove: true,
      }),
    ).toBeNull();
  });

  test("the closed month boundary is inclusive for every role", () => {
    const policy = {
      ...DEFAULT_TIME_POLICY,
      timeLockedThroughMonth: "2024-02-29",
    };
    for (const canApprove of [false, true]) {
      expect(
        getTimePolicyViolation({
          policy,
          dateWorked: "2024-02-29",
          today: "2024-03-01",
          canApprove,
        })?.code,
      ).toBe("time_period_locked");
      expect(
        getTimePolicyViolation({
          policy,
          dateWorked: "2024-03-01",
          today: "2024-03-01",
          canApprove,
        }),
      ).toBeNull();
    }
  });

  test("requires a nonblank narrative only when configured", () => {
    const input = {
      policy: DEFAULT_TIME_POLICY,
      dateWorked: "2024-03-01",
      today: "2024-03-01",
      canApprove: false,
      narrative: "  ",
    };
    expect(getTimePolicyViolation(input)?.code).toBe("narrative_required");
    expect(
      getTimePolicyViolation({ ...input, narrative: undefined }),
    ).toBeNull();
    expect(
      getTimePolicyViolation({
        ...input,
        policy: { ...DEFAULT_TIME_POLICY, timeNarrativeRequired: false },
      }),
    ).toBeNull();
  });
});
