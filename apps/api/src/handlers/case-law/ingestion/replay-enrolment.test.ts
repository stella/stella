import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

import {
  REPLAY_ENROLMENT,
  replayWaveAdmission,
  validateReplayEnrolment,
} from "./replay-enrolment";

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
        reviewedParserVersion: 1,
        reviewedDryRun,
      }),
    ).toThrow("Replay enrolment requires a reviewed dry run");
  }
  validateReplayEnrolment({ mode: "off" });
  validateReplayEnrolment({ mode: "dry-run" });
  validateReplayEnrolment({
    mode: "enrolled",
    reviewedParserVersion: 1,
    reviewedDryRun: "fixture receipt",
  });
});

test.each([
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
])(
  "a reviewed wave rejects invalid parser version %p",
  (reviewedParserVersion) => {
    expect(() =>
      validateReplayEnrolment({
        mode: "enrolled",
        reviewedDryRun: "fixture receipt",
        reviewedParserVersion,
      }),
    ).toThrow("Replay enrolment requires a positive reviewed parser version");
  },
);

test("a reviewed replay wave admits exactly its parser version", () => {
  assertProperty(
    "a reviewed replay wave admits exactly its parser version",
    fc.property(
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 1, max: 10_000 }),
      (reviewedParserVersion, currentParserVersion) => {
        const policy = {
          mode: "enrolled",
          reviewedDryRun: "fixture receipt",
          reviewedParserVersion,
        } as const;
        expect(replayWaveAdmission(policy, reviewedParserVersion)).toEqual({
          status: "admit",
          mode: "enrolled",
        });
        if (currentParserVersion !== reviewedParserVersion) {
          expect(replayWaveAdmission(policy, currentParserVersion)).toEqual({
            status: "held",
            reason: "unreviewed-parser-version",
            reviewedParserVersion,
            currentParserVersion,
          });
        }
        expect(
          replayWaveAdmission({ mode: "off" }, currentParserVersion),
        ).toEqual({ status: "held", reason: "replay-off" });
        expect(
          replayWaveAdmission({ mode: "dry-run" }, currentParserVersion),
        ).toEqual({ status: "admit", mode: "dry-run" });
        expect(
          replayWaveAdmission(
            {
              ...policy,
              reviewedParserVersion: currentParserVersion,
              reviewedDryRun: "new reviewed receipt",
            },
            currentParserVersion,
          ),
        ).toEqual({ status: "admit", mode: "enrolled" });
      },
    ),
  );
});
