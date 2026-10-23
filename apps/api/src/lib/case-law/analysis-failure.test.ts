import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { PROVIDER_RETRY_WAIT_CAP_MS } from "@/api/lib/errors/provider-retry-delay";

import {
  ANALYSIS_FAILURE_HOLD_MS,
  analysisFailureKeyTag,
  analysisFailureRecord,
  type AnalysisReaderKey,
  type AnalysisRequestKind,
  failureClaimGuard,
  failureMatchesGuard,
  failureStillHolds,
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
        reader: ORG_KEY,
        request: "poll",
      }),
    ).toBe(true);
  });

  test("a failure past its hold no longer holds: the next open runs anew", () => {
    expect(
      failureStillHolds({
        failure: recordedAt(new Date(NOW.getTime() - ANALYSIS_FAILURE_HOLD_MS)),
        fingerprint: CURRENT,
        now: NOW,
        reader: ORG_KEY,
        request: "poll",
      }),
    ).toBe(false);
  });

  test("a failure over a previous parse no longer holds", () => {
    expect(
      failureStillHolds({
        failure: recordedAt(NOW),
        fingerprint: PREVIOUS,
        now: NOW,
        reader: ORG_KEY,
        request: "poll",
      }),
    ).toBe(false);
  });

  test("a failure no longer holds once the organization runs a different provider", () => {
    expect(
      failureStillHolds({
        failure: recordedAt(NOW),
        fingerprint: CURRENT,
        now: NOW,
        reader: { ...ORG_KEY, provider: "anthropic" },
        request: "poll",
      }),
    ).toBe(false);
  });

  test("files the retry time of the failing answer, short or long", () => {
    const withDelay = (retryAfterMs: number | undefined) =>
      analysisFailureRecord({
        code: "provider_refused",
        fingerprint: CURRENT,
        now: NOW,
        reader: ORG_KEY,
        retryAfterMs,
      }).retryAfter;

    expect(withDelay(undefined)).toBeUndefined();
    expect(withDelay(0)).toBeUndefined();
    // A refusal of the call's own retry after its one wait: still current.
    expect(withDelay(5000)).toEqual(new Date(NOW.getTime() + 5000));
    expect(withDelay(PROVIDER_RETRY_WAIT_CAP_MS + 1)).toEqual(
      new Date(NOW.getTime() + PROVIDER_RETRY_WAIT_CAP_MS + 1),
    );
  });

  describe("a failure with a provider retry time", () => {
    const LONG_DELAY_MS = 11.5 * 60 * 60 * 1000;
    const failure = analysisFailureRecord({
      code: "provider_refused",
      fingerprint: CURRENT,
      now: NOW,
      reader: ORG_KEY,
      retryAfterMs: LONG_DELAY_MS,
    });
    const holdsAt = (at: Date, request: AnalysisRequestKind) =>
      failureStillHolds({
        failure,
        fingerprint: CURRENT,
        now: at,
        reader: ORG_KEY,
        request,
      });
    const pastHold = new Date(NOW.getTime() + ANALYSIS_FAILURE_HOLD_MS + 1);
    const atRetryTime = new Date(NOW.getTime() + LONG_DELAY_MS);

    test("holds polls and explicit retries alike until that time, past the plain hold", () => {
      for (const request of ["poll", "retry"] as const) {
        expect(holdsAt(NOW, request)).toBe(true);
        expect(holdsAt(pastHold, request)).toBe(true);
        expect(holdsAt(new Date(atRetryTime.getTime() - 1), request)).toBe(
          true,
        );
        expect(holdsAt(atRetryTime, request)).toBe(false);
      }
    });

    test("answers the claim guard by the same rule", () => {
      for (const request of ["poll", "retry"] as const) {
        for (const at of [NOW, pastHold, atRetryTime]) {
          expect(
            failureMatchesGuard({
              failure,
              fingerprint: CURRENT,
              guard: failureClaimGuard({
                decisionId: DECISION,
                now: at,
                reader: ORG_KEY,
                request,
              }),
            }),
          ).toBe(holdsAt(at, request));
        }
      }
    });
  });

  test("a failure without a retry time never holds an explicit retry", () => {
    expect(
      failureStillHolds({
        failure: recordedAt(NOW),
        fingerprint: CURRENT,
        now: NOW,
        reader: ORG_KEY,
        request: "retry",
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
