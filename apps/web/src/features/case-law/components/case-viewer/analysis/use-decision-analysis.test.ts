import { describe, expect, test } from "bun:test";

import type {
  AnalysisHeading,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";

import {
  analysisStateFromQuery,
  parseAnalysisResponse,
} from "./use-decision-analysis";

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

  test("accepts an error without exposing its transport message", () => {
    expect(
      parseAnalysisResponse({ status: "error", error: "HTTP 500" }),
    ).toEqual({ status: "error" });
  });
});

describe("decision analysis query state", () => {
  test("a retry replaces the retained error with progress", () => {
    expect(
      analysisStateFromQuery({
        hasQueryError: false,
        isFetching: true,
        result: { kind: "error" },
      }),
    ).toEqual({ status: "generating", tree: [] });
  });

  test("a settled result remains an error", () => {
    expect(
      analysisStateFromQuery({
        hasQueryError: false,
        isFetching: false,
        result: { kind: "error" },
      }),
    ).toEqual({ status: "error" });
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
    ).toEqual({ status: "error" });
  });
});
