import { describe, expect, test } from "bun:test";

import type {
  AnalysisFailureCode,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";
import {
  ANALYSIS_FAILURE_CODES,
  parsePersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

import {
  ANALYSIS_FAILURE_HOLD_MS,
  analysisFailure,
  analysisSentinel,
  failureAnswersReader,
  SENTINEL_STALE_MS,
  storedAnalysisState,
  type AnalysisReaderKey,
} from "./stored-analysis";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const CURRENT = "c".repeat(64);
const PREVIOUS = "p".repeat(64);

const analysisOver = (fingerprint: string): DecisionAnalysis => ({
  version: 2,
  generatedAt: "2026-08-31T09:00:00.000Z",
  model: "test-model",
  inputFingerprint: fingerprint,
  tree: [],
});

describe("storedAnalysisState", () => {
  test("a finished analysis over the current input is done", () => {
    const stored = analysisOver(CURRENT);
    expect(
      storedAnalysisState({ stored, fingerprint: CURRENT, now: NOW }),
    ).toEqual({ kind: "done", analysis: stored });
  });

  test("a finished analysis over a previous parse is nothing: its anchors name blocks that no longer exist", () => {
    expect(
      storedAnalysisState({
        stored: analysisOver(PREVIOUS),
        fingerprint: CURRENT,
        now: NOW,
      }),
    ).toEqual({ kind: "none" });
  });

  test("a fresh sentinel over the current input is a run in flight", () => {
    const stored = analysisSentinel(
      CURRENT,
      new Date(NOW.getTime() - SENTINEL_STALE_MS + 1),
    );
    expect(
      storedAnalysisState({ stored, fingerprint: CURRENT, now: NOW }),
    ).toEqual({ kind: "generating" });
  });

  test("a sentinel that outlived its run is nothing", () => {
    const stored = analysisSentinel(
      CURRENT,
      new Date(NOW.getTime() - SENTINEL_STALE_MS),
    );
    expect(
      storedAnalysisState({ stored, fingerprint: CURRENT, now: NOW }),
    ).toEqual({ kind: "none" });
  });

  test("a fresh sentinel over a previous parse is nothing", () => {
    expect(
      storedAnalysisState({
        stored: analysisSentinel(PREVIOUS, NOW),
        fingerprint: CURRENT,
        now: NOW,
      }),
    ).toEqual({ kind: "none" });
  });

  test("a value without a fingerprint, including a version-1 row, is nothing", () => {
    const { inputFingerprint: _absent, ...v1 } = analysisOver(CURRENT);
    expect(
      storedAnalysisState({
        stored: { ...v1, version: 1 },
        fingerprint: CURRENT,
        now: NOW,
      }),
    ).toEqual({ kind: "none" });
    expect(
      storedAnalysisState({ stored: null, fingerprint: CURRENT, now: NOW }),
    ).toEqual({ kind: "none" });
  });
});

describe("a failed run's record", () => {
  const DECISION = toSafeId<"caseLawDecision">(
    "01a02a37-2222-7222-8222-222222222222",
  );
  const ORG_A = toSafeId<"organization">("org_a");
  const orgKey = (
    organizationId: SafeId<"organization">,
    provider = "google",
  ): AnalysisReaderKey => ({
    source: "organization",
    organizationId,
    provider,
  });
  const PLATFORM: AnalysisReaderKey = { source: "platform" };

  const failedAt = (
    at: Date,
    reader: AnalysisReaderKey = orgKey(ORG_A),
    code: AnalysisFailureCode = "answer_incomplete",
  ) =>
    analysisFailure({
      code,
      decisionId: DECISION,
      fingerprint: CURRENT,
      now: at,
      reader,
    });

  test("every failure code round-trips through the persisted parser", () => {
    for (const code of ANALYSIS_FAILURE_CODES) {
      for (const reader of [orgKey(ORG_A), PLATFORM]) {
        const failure = failedAt(NOW, reader, code);
        expect(parsePersistedDecisionAnalysis(failure)).toEqual(failure);
        expect(parsePersistedDecisionAnalysis(JSON.stringify(failure))).toEqual(
          failure,
        );
      }
    }
  });

  test("a fresh failure over the current input is failed, so polling never restarts it", () => {
    const failure = failedAt(
      new Date(NOW.getTime() - ANALYSIS_FAILURE_HOLD_MS + 1),
    );
    expect(
      storedAnalysisState({ stored: failure, fingerprint: CURRENT, now: NOW }),
    ).toEqual({ kind: "failed", failure });
  });

  test("a failure past its hold is nothing: the next open runs anew", () => {
    expect(
      storedAnalysisState({
        stored: failedAt(new Date(NOW.getTime() - ANALYSIS_FAILURE_HOLD_MS)),
        fingerprint: CURRENT,
        now: NOW,
      }),
    ).toEqual({ kind: "none" });
  });

  test("a failure over a previous parse is nothing", () => {
    expect(
      storedAnalysisState({
        stored: { ...failedAt(NOW), inputFingerprint: PREVIOUS },
        fingerprint: CURRENT,
        now: NOW,
      }),
    ).toEqual({ kind: "none" });
  });

  test("a failure with an unreadable time is nothing", () => {
    expect(
      storedAnalysisState({
        stored: { ...failedAt(NOW), failedAt: "not a time" },
        fingerprint: CURRENT,
        now: NOW,
      }),
    ).toEqual({ kind: "none" });
  });

  test("a failure answers the reader whose key recorded it", () => {
    for (const reader of [orgKey(ORG_A), PLATFORM]) {
      expect(
        failureAnswersReader({
          decisionId: DECISION,
          failure: failedAt(NOW, reader),
          reader,
        }),
      ).toBe(true);
    }
  });
});
