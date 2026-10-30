import { expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

import { getAdapter } from "./adapters/adapter-registry";
import { replayCapability } from "./replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
  validateReplayEnrolment,
} from "./replay-enrolment";

test("the committed registry previews only the Constitutional Court and the common courts portal, and enrolment validates its budget and reviewed dry run", () => {
  expect(
    Object.entries(REPLAY_ENROLMENT).filter(([, { mode }]) => mode !== "off"),
  ).toEqual([
    [ADAPTER_KEYS.CZ_US, { mode: "dry-run", dailyBudget: 10_000 }],
    [ADAPTER_KEYS.PL_NCOURT, { mode: "dry-run", dailyBudget: 10_000 }],
  ]);
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

// The replay tick refuses to start while any previewed or enrolled source's
// adapter cannot re-parse stored raw; this keeps that refusal out of the
// committed map.
test("every previewed or enrolled source's adapter can replay stored raw", () => {
  for (const [adapterKey, { mode }] of Object.entries(REPLAY_ENROLMENT)) {
    if (mode === "off") {
      continue;
    }
    const adapter = getAdapter(adapterKey);
    expect(
      adapter === undefined ? "unregistered" : replayCapability(adapter).type,
      adapterKey,
    ).toBe("supported");
  }
});
