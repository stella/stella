import { expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  validateReplayEnrolment,
} from "./replay-enrolment";

test("the committed registry previews approved parser sources with bounded daily budgets", () => {
  expect(
    Object.entries(REPLAY_ENROLMENT).filter(([, { mode }]) => mode !== "off"),
  ).toEqual(
    [
      ADAPTER_KEYS.CZ_NSS,
      ADAPTER_KEYS.CZ_US,
      ADAPTER_KEYS.PL_COURTS,
      ADAPTER_KEYS.PL_SN,
      ADAPTER_KEYS.PL_KIO,
      ADAPTER_KEYS.PL_NCOURT,
      ADAPTER_KEYS.PL_KIS,
      ADAPTER_KEYS.PL_UOKIK,
      ADAPTER_KEYS.CZ_UOHS,
    ].map((key) => [key, { mode: "dry-run", dailyBudget: 10_000 }]),
  );
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
