import { expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

import { REPLAY_ENROLMENT, validateReplayEnrolment } from "./replay-enrolment";

test("the committed registry previews only the Constitutional Court and enrolment requires a reviewed dry run", () => {
  expect(
    Object.entries(REPLAY_ENROLMENT).filter(([, { mode }]) => mode !== "off"),
  ).toEqual([[ADAPTER_KEYS.CZ_US, { mode: "dry-run" }]]);
  for (const policy of Object.values(REPLAY_ENROLMENT)) {
    validateReplayEnrolment(policy);
  }
  for (const reviewedDryRun of ["", "  "]) {
    expect(() =>
      validateReplayEnrolment({
        mode: "enrolled",

        reviewedDryRun,
      }),
    ).toThrow("Replay enrolment requires a reviewed dry run");
  }
  validateReplayEnrolment({ mode: "off" });
  validateReplayEnrolment({ mode: "dry-run" });
  validateReplayEnrolment({
    mode: "enrolled",

    reviewedDryRun: "fixture receipt",
  });
});
