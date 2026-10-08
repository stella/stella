import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  ANALYSIS_FAILURE_HOLD_MS,
  analysisFailureKeyTag,
  analysisFailureRecord,
  failureStillHolds,
  type AnalysisReaderKey,
} from "./analysis-failure";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const CURRENT = "c".repeat(64);
const PREVIOUS = "p".repeat(64);
const DECISION = toSafeId<"caseLawDecision">(
  "01a02a37-2222-7222-8222-222222222222",
);
const ORG_KEY: AnalysisReaderKey = {
  source: "organization",
  organizationId: toSafeId<"organization">("org_a"),
  provider: "google",
};
const PLATFORM: AnalysisReaderKey = { source: "platform" };

const recordedAt = (at: Date, reader: AnalysisReaderKey = ORG_KEY) =>
  analysisFailureRecord({
    code: "answer_incomplete",
    fingerprint: CURRENT,
    now: at,
    reader,
  });

describe("a failed run's record", () => {
  test("names whose key the run used", () => {
    expect(recordedAt(NOW)).toMatchObject({
      keySource: "organization",
      provider: "google",
    });
    expect(recordedAt(NOW, PLATFORM)).toMatchObject({
      keySource: "platform",
      provider: null,
    });
  });

  test("a fresh failure over the current input still holds, so polling never restarts it", () => {
    expect(
      failureStillHolds({
        failure: recordedAt(
          new Date(NOW.getTime() - ANALYSIS_FAILURE_HOLD_MS + 1),
        ),
        fingerprint: CURRENT,
        now: NOW,
      }),
    ).toBe(true);
  });

  test("a failure past its hold no longer holds: the next open runs anew", () => {
    expect(
      failureStillHolds({
        failure: recordedAt(new Date(NOW.getTime() - ANALYSIS_FAILURE_HOLD_MS)),
        fingerprint: CURRENT,
        now: NOW,
      }),
    ).toBe(false);
  });

  test("a failure over a previous parse no longer holds", () => {
    expect(
      failureStillHolds({
        failure: recordedAt(NOW),
        fingerprint: PREVIOUS,
        now: NOW,
      }),
    ).toBe(false);
  });

  test("the same reader key files under the same tag every time", () => {
    for (const reader of [ORG_KEY, PLATFORM]) {
      expect(analysisFailureKeyTag(reader, DECISION)).toBe(
        analysisFailureKeyTag(reader, DECISION),
      );
    }
  });
});
