import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_ANALYSIS_FAILURE_CODES,
  CASE_LAW_ANALYSIS_UNAVAILABLE_CODES,
} from "@stll/api-contract";
import type {
  AnalysisHeading,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";

import {
  type AnalysisError,
  parseAnalysisResponse,
} from "@/features/case-law/queries/decision-analysis";

import {
  analysisRetryOf,
  analysisStateFromQuery,
} from "./use-decision-analysis";

const UNREADABLE: AnalysisError = { kind: "unreadable" };

const heading = {
  id: "h1",
  label: "Facts",
  category: "facts",
  startAnchorId: "a1",
  endAnchorId: "a2",
  annotations: [],
  children: [],
} satisfies AnalysisHeading;

const analysis = {
  version: 2,
  generatedAt: "2026-08-23T10:00:00.000Z",
  model: "test-model",
  inputFingerprint: "f".repeat(64),
  tree: [heading],
} satisfies DecisionAnalysis;

describe("decision analysis response parsing", () => {
  test("accepts a complete analysis", () => {
    expect(parseAnalysisResponse({ status: "done", analysis })).toEqual({
      status: "done",
      analysis,
    });
  });

  test("a generating response carries no tree yet", () => {
    expect(
      parseAnalysisResponse({
        status: "generating",
        analysis: {
          version: 2,
          status: "generating",
          startedAt: "2026-08-23T10:00:00.000Z",
          inputFingerprint: "f".repeat(64),
        },
      }),
    ).toEqual({ status: "generating", tree: [] });
  });

  test("rejects a sentinel presented as complete", () => {
    expect(
      parseAnalysisResponse({
        status: "done",
        analysis: {
          version: 2,
          status: "generating",
          startedAt: "2026-08-23T10:00:00.000Z",
          inputFingerprint: "f".repeat(64),
        },
      }),
    ).toBeNull();
  });

  test("rejects an analysis without a fingerprint", () => {
    const { inputFingerprint: _absent, ...unfingerprinted } = analysis;
    expect(
      parseAnalysisResponse({ status: "done", analysis: unfingerprinted }),
    ).toBeNull();
  });

  test("an error without a code it knows is unreadable, never a guessed message", () => {
    expect(
      parseAnalysisResponse({ status: "error", error: "HTTP 500" }),
    ).toEqual({ status: "error", error: { kind: "unreadable" } });
    expect(
      parseAnalysisResponse({ status: "error", code: "something_new" }),
    ).toEqual({ status: "error", error: { kind: "unreadable" } });
  });

  test("reads every code the server will not analyse a decision for", () => {
    for (const code of CASE_LAW_ANALYSIS_UNAVAILABLE_CODES) {
      expect(
        parseAnalysisResponse({ status: "error", code, error: "x" }),
      ).toEqual({ status: "error", error: { kind: "unavailable", code } });
    }
  });

  test("reads every failed-run code with whose key the run used", () => {
    for (const code of CASE_LAW_ANALYSIS_FAILURE_CODES) {
      expect(
        parseAnalysisResponse({
          status: "error",
          code,
          error: "x",
          key: { source: "organization", provider: "google" },
        }),
      ).toEqual({
        status: "error",
        error: {
          kind: "failed",
          code,
          key: { source: "organization", provider: "google" },
        },
      });
      expect(
        parseAnalysisResponse({
          status: "error",
          code,
          error: "x",
          key: { source: "platform" },
        }),
      ).toEqual({
        status: "error",
        error: { kind: "failed", code, key: { source: "platform" } },
      });
    }
  });

  test("a failed run without a readable key is unreadable", () => {
    for (const key of [
      undefined,
      { source: "organization" },
      { source: "organization", provider: "" },
      { source: "someone-else" },
    ]) {
      expect(
        parseAnalysisResponse({
          status: "error",
          code: "timed_out",
          error: "x",
          key,
        }),
      ).toEqual({ status: "error", error: { kind: "unreadable" } });
    }
  });
});

describe("decision analysis query state", () => {
  test("a retry replaces the retained error with progress", () => {
    expect(
      analysisStateFromQuery({
        hasQueryError: false,
        isFetching: true,
        result: { kind: "error", error: UNREADABLE },
      }),
    ).toEqual({ status: "generating", tree: [] });
  });

  test("a settled result remains an error", () => {
    expect(
      analysisStateFromQuery({
        hasQueryError: false,
        isFetching: false,
        result: { kind: "error", error: UNREADABLE },
      }),
    ).toEqual({ status: "error", error: UNREADABLE });
  });

  test("a thrown request error becomes progress only while retrying", () => {
    expect(
      analysisStateFromQuery({
        hasQueryError: true,
        isFetching: true,
        result: undefined,
      }),
    ).toEqual({ status: "generating", tree: [] });
    expect(
      analysisStateFromQuery({
        hasQueryError: true,
        isFetching: false,
        result: undefined,
      }),
    ).toEqual({ status: "error", error: UNREADABLE });
  });

  test("a failed run's named error reaches the reader state unchanged", () => {
    const error = {
      kind: "failed",
      code: "timed_out",
      key: { source: "organization", provider: "google" },
    } satisfies AnalysisError;
    expect(
      analysisStateFromQuery({
        hasQueryError: false,
        isFetching: false,
        result: { kind: "error", error },
      }),
    ).toEqual({ status: "error", error });
  });
});

describe("what Retry does for each analysis error", () => {
  test("a failed run asks for a new run, for every failure code and key", () => {
    for (const code of CASE_LAW_ANALYSIS_FAILURE_CODES) {
      for (const key of [
        { source: "organization", provider: "google" },
        { source: "platform" },
      ] as const) {
        expect(analysisRetryOf({ kind: "failed", code, key })).toBe("new-run");
      }
    }
  });

  test("an unreadable answer is read again: it may have been a transport blip", () => {
    expect(analysisRetryOf(UNREADABLE)).toBe("read-again");
  });

  test("a decision the server will never analyse offers no retry", () => {
    for (const code of CASE_LAW_ANALYSIS_UNAVAILABLE_CODES) {
      expect(analysisRetryOf({ kind: "unavailable", code })).toBe("none");
    }
  });
});
