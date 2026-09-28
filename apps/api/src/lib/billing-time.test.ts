import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TIME_POLICY,
  getTimePolicyViolation,
  roundToBillingIncrement,
} from "./billing-time";

describe("time policy", () => {
  test("rounds every duration to the configured unit", () => {
    for (const unit of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]) {
      for (let minutes = 0; minutes <= 180; minutes++) {
        const billed = roundToBillingIncrement(minutes, unit);
        expect(billed % unit).toBe(0);
        expect(billed).toBeGreaterThanOrEqual(minutes);
        expect(billed).toBeLessThan(minutes + unit);
      }
    }
    expect(roundToBillingIncrement(7, 15)).toBe(15);
  });

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
      getTimePolicyViolation({
        ...input,
        policy: { ...DEFAULT_TIME_POLICY, timeNarrativeRequired: false },
      }),
    ).toBeNull();
  });
});
