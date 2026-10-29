import { expect, test } from "bun:test";

import { listAdapters } from "./adapters/adapter-registry";
import { replayCapability } from "./replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  validateReplayEnrolment,
} from "./replay-enrolment";

test("the committed replay registry validates its budgets and reviewed dry runs", () => {
  for (const policy of Object.values(REPLAY_ENROLMENT)) {
    validateReplayEnrolment(policy);
  }
  for (const dailyBudget of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BACKGROUND_REPLAY_LIMITS.maxDailyBudget + 1,
  ]) {
    for (const policy of [
      { mode: "dry-run", dailyBudget },
      { mode: "enrolled", dailyBudget, reviewedDryRun: "fixture receipt" },
    ] as const) {
      expect(() => validateReplayEnrolment(policy)).toThrow(
        "Replay daily budget must be a positive bounded integer",
      );
    }
  }
  for (const reviewedDryRun of ["", "  "]) {
    expect(() =>
      validateReplayEnrolment({
        mode: "enrolled",
        dailyBudget: 1,
        reviewedDryRun,
      }),
    ).toThrow("Replay enrolment requires a reviewed dry run");
  }
  validateReplayEnrolment({ mode: "off" });
  validateReplayEnrolment({ mode: "dry-run", dailyBudget: 1 });
  validateReplayEnrolment({
    mode: "enrolled",
    dailyBudget: BACKGROUND_REPLAY_LIMITS.maxDailyBudget,
    reviewedDryRun: "fixture receipt",
  });
});

test("every enabled replay source can reparse its archived input", () => {
  for (const adapter of listAdapters()) {
    if (REPLAY_ENROLMENT[adapter.key].mode === "off") {
      continue;
    }
    expect({
      adapter: adapter.key,
      capability: replayCapability(adapter).type,
    }).toEqual({
      adapter: adapter.key,
      capability: "supported",
    });
  }
});
