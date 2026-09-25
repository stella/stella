import { describe, expect, test } from "bun:test";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import {
  analysisSentinel,
  SENTINEL_STALE_MS,
  storedAnalysisState,
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
