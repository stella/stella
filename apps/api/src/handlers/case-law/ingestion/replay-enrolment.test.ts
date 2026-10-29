import { expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  validateReplayEnrolment,
} from "./replay-enrolment";

test("the committed registry previews only the Constitutional Court and the Austrian sources, and enrolment validates its budget and reviewed dry run", () => {
  expect(
    Object.entries(REPLAY_ENROLMENT).filter(([, { mode }]) => mode !== "off"),
  ).toEqual(
    [
      ADAPTER_KEYS.CZ_US,
      ADAPTER_KEYS.AT_COURTS,
      ADAPTER_KEYS.AT_VFGH,
      ADAPTER_KEYS.AT_VWGH,
      ADAPTER_KEYS.AT_BVWG,
      ADAPTER_KEYS.AT_LVWG,
      ADAPTER_KEYS.AT_ASYLGH,
      ADAPTER_KEYS.AT_UBAS,
      ADAPTER_KEYS.AT_UVS,
      ADAPTER_KEYS.AT_VERG,
      ADAPTER_KEYS.AT_UMSE,
      ADAPTER_KEYS.AT_BKS,
      ADAPTER_KEYS.AT_FINDOK,
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
