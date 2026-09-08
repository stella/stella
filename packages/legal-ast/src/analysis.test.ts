import { describe, expect, test } from "bun:test";

import {
  ANALYSIS_ABSTRACT_MAX_LENGTH,
  ANALYSIS_HOLDING_MAX_ANCHORS,
  ANALYSIS_HOLDING_MAX_LENGTH,
  ANALYSIS_MAX_TOPICS,
  ANALYSIS_SIGNIFICANCE_MAX_LENGTH,
  ANALYSIS_TOPIC_MAX_LENGTH,
  analysisLayersOf,
  CURRENT_ANALYSIS_VERSION,
  isAnalysisGenerating,
  isDecisionAnalysis,
  isSignificanceCurrent,
  parsePersistedDecisionAnalysis,
} from "./analysis";
import type {
  AnalysisHeading,
  AnalysisSignificance,
  DecisionAnalysis,
  DecisionAnalysisV3,
} from "./analysis";

const FINGERPRINT = "a".repeat(64);

const heading = {
  id: "h1",
  label: "Heading",
  category: "facts",
  startAnchorId: "a1",
  endAnchorId: "a2",
  annotations: [],
  children: [],
} satisfies AnalysisHeading;

const analysis = {
  version: 2,
  generatedAt: "2026-04-30T12:00:00.000Z",
  model: "test-model",
  inputFingerprint: FINGERPRINT,
  tree: [heading],
} satisfies DecisionAnalysis;

describe("parsePersistedDecisionAnalysis", () => {
  test("keeps a fingerprinted generating sentinel", () => {
    const sentinel = {
      version: CURRENT_ANALYSIS_VERSION,
      status: "generating",
      startedAt: "2026-04-30T12:00:00.000Z",
      inputFingerprint: FINGERPRINT,
    } as const;

    expect(parsePersistedDecisionAnalysis(sentinel)).toEqual(sentinel);
    expect(isAnalysisGenerating(sentinel)).toBe(true);
  });

  test("rejects a sentinel without a fingerprint", () => {
    expect(
      parsePersistedDecisionAnalysis({
        version: CURRENT_ANALYSIS_VERSION,
        status: "generating",
        startedAt: "2026-04-30T12:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parsePersistedDecisionAnalysis({
        version: CURRENT_ANALYSIS_VERSION,
        status: "generating",
        startedAt: "2026-04-30T12:00:00.000Z",
        inputFingerprint: "",
      }),
    ).toBeNull();
  });

  // A run that a previous release left mid-flight holds a sentinel at the
  // older version. It reads as no analysis, which is what makes the row
  // claimable again rather than pinned in "generating" forever.
  test("reads a sentinel from an older version as no analysis", () => {
    expect(
      parsePersistedDecisionAnalysis({
        version: 2,
        status: "generating",
        startedAt: "2026-04-30T12:00:00.000Z",
        inputFingerprint: FINGERPRINT,
      }),
    ).toBeNull();
  });

  test("reads version-1 rows as no analysis: nothing ties them to the document", () => {
    const { inputFingerprint: _absent, ...v1Analysis } = analysis;
    expect(parsePersistedDecisionAnalysis({ ...v1Analysis, version: 1 })).toBe(
      null,
    );
    expect(
      parsePersistedDecisionAnalysis({
        version: 1,
        status: "generating",
        startedAt: "2026-04-30T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("rejects a complete analysis without a fingerprint", () => {
    const { inputFingerprint: _absent, ...unfingerprinted } = analysis;
    expect(isDecisionAnalysis(unfingerprinted)).toBe(false);
    expect(parsePersistedDecisionAnalysis(unfingerprinted)).toBeNull();
  });

  test("returns the canonical parsed payload instead of the raw object", () => {
    expect(
      parsePersistedDecisionAnalysis({
        ...analysis,
        tree: [{ ...heading, staleProducerField: true }],
      }),
    ).toEqual(analysis);
    expect(parsePersistedDecisionAnalysis(JSON.stringify(analysis))).toEqual(
      analysis,
    );
  });

  test("rejects a decision analysis with malformed headings", () => {
    const malformed = {
      ...analysis,
      tree: [{ id: "missing-required-fields" }],
    };

    expect(isDecisionAnalysis(malformed)).toBe(false);
    expect(parsePersistedDecisionAnalysis(malformed)).toBeNull();
  });

  test("requires recursively complete children for persisted headings", () => {
    const malformed = {
      ...analysis,
      tree: [{ ...heading, children: [{ id: "incomplete-child" }] }],
    };

    expect(isDecisionAnalysis(malformed)).toBe(false);
    expect(
      parsePersistedDecisionAnalysis(JSON.stringify(malformed)),
    ).toBeNull();
  });

  test("returns null for strings that are not JSON", () => {
    expect(parsePersistedDecisionAnalysis("{not json")).toBeNull();
  });
});

const significance = {
  text: "Followed by later panels of the same court.",
  language: "cs",
  graphFingerprint: "g".repeat(64),
  generatedAt: "2026-05-01T12:00:00.000Z",
  model: "test-model",
  promptVersion: 1,
} satisfies AnalysisSignificance;

const v3 = {
  version: 3,
  generatedAt: "2026-04-30T12:00:00.000Z",
  model: "test-model",
  inputFingerprint: FINGERPRINT,
  tree: [heading],
  holding: {
    text: "A limitation period runs from the day the claim could first be brought.",
    language: "cs",
    anchors: [{ startAnchorId: "a1", endAnchorId: "a2" }],
  },
  abstract: {
    text: "The court answered the limitation question.",
    language: "cs",
  },
  topics: ["limitation period"],
} satisfies DecisionAnalysisV3;

describe("version 3 layers", () => {
  test("round-trips every layer, significance included", () => {
    const withSignificance = { ...v3, significance };
    expect(parsePersistedDecisionAnalysis(withSignificance)).toEqual(
      withSignificance,
    );
    expect(isDecisionAnalysis(withSignificance)).toBe(true);
  });

  test("keeps version 2 rows readable, and reports no layers for them", () => {
    expect(parsePersistedDecisionAnalysis(analysis)).toEqual(analysis);
    expect(analysisLayersOf(analysis)).toEqual({
      holding: null,
      abstract: null,
      topics: [],
      significance: null,
    });
  });

  test("refuses a version 2 row that carries a version 3 layer", () => {
    expect(
      parsePersistedDecisionAnalysis({ ...analysis, topics: ["x"] }),
    ).toBeNull();
  });

  test("requires every document-fenced layer on a version 3 row", () => {
    for (const missing of ["holding", "abstract", "topics"] as const) {
      const { [missing]: _absent, ...partial } = v3;
      expect(parsePersistedDecisionAnalysis(partial)).toBeNull();
    }
  });

  test("bounds every written layer", () => {
    const overLong = (length: number) => "x".repeat(length + 1);
    const cases: DecisionAnalysis[] = [
      {
        ...v3,
        holding: { ...v3.holding, text: overLong(ANALYSIS_HOLDING_MAX_LENGTH) },
      },
      {
        ...v3,
        holding: {
          ...v3.holding,
          anchors: Array.from(
            { length: ANALYSIS_HOLDING_MAX_ANCHORS + 1 },
            () => ({ startAnchorId: "a1", endAnchorId: "a2" }),
          ),
        },
      },
      {
        ...v3,
        abstract: {
          ...v3.abstract,
          text: overLong(ANALYSIS_ABSTRACT_MAX_LENGTH),
        },
      },
      { ...v3, topics: [overLong(ANALYSIS_TOPIC_MAX_LENGTH)] },
      {
        ...v3,
        topics: Array.from({ length: ANALYSIS_MAX_TOPICS + 1 }, (_, i) =>
          String(i),
        ),
      },
      {
        ...v3,
        significance: {
          ...significance,
          text: overLong(ANALYSIS_SIGNIFICANCE_MAX_LENGTH),
        },
      },
    ];
    for (const candidate of cases) {
      expect(parsePersistedDecisionAnalysis(candidate)).toBeNull();
    }
    expect(parsePersistedDecisionAnalysis({ ...v3, topics: [""] })).toBeNull();
  });

  test("reads significance as stale unless it names the current graph", () => {
    const withSignificance = { ...v3, significance };
    const current = (
      graphFingerprint: string,
      promptVersion = significance.promptVersion,
    ) =>
      isSignificanceCurrent({
        analysis: withSignificance,
        graphFingerprint,
        promptVersion,
      });

    expect(current(significance.graphFingerprint)).toBe(true);
    expect(current("h".repeat(64))).toBe(false);
    // A reworded prompt is a reason to write it again: the graph
    // fingerprint digests the graph, so nothing else would notice.
    expect(current(significance.graphFingerprint, 2)).toBe(false);
    // Absent and stale are the same answer.
    expect(
      isSignificanceCurrent({
        analysis: v3,
        graphFingerprint: significance.graphFingerprint,
        promptVersion: significance.promptVersion,
      }),
    ).toBe(false);
    expect(
      isSignificanceCurrent({
        analysis,
        graphFingerprint: significance.graphFingerprint,
        promptVersion: significance.promptVersion,
      }),
    ).toBe(false);
  });

  test("the sentinel is written at the current version", () => {
    expect(CURRENT_ANALYSIS_VERSION).toBe(3);
  });
});
