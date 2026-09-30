import { describe, expect, test } from "bun:test";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { timerActivityOptions } from "./global-timer-confirmation.logic";

describe("timer confirmation activity choices", () => {
  test("matterless timers offer internal work and default to it", () => {
    const options = timerActivityOptions(null);
    expect(options.defaultActivityGroup).toBe(
      TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
    );
    expect(options.activityGroups).toEqual([
      TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
      TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
    ]);
  });
  test("assigned timers only offer client work", () => {
    for (const matterId of ["matter-one", "matter-two"]) {
      const options = timerActivityOptions(matterId);
      expect(options.defaultActivityGroup).toBe(
        TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
      );
      expect(options.activityGroups).toEqual([
        TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
      ]);
    }
  });
});
