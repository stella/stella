import { describe, expect, test } from "bun:test";

import {
  isAnalysisGenerating,
  isDecisionAnalysis,
  parsePersistedDecisionAnalysis,
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
};

const analysis = {
  version: 2,
  generatedAt: "2026-04-30T12:00:00.000Z",
  model: "test-model",
  inputFingerprint: FINGERPRINT,
  tree: [heading],
} as const;

describe("parsePersistedDecisionAnalysis", () => {
  test("keeps a fingerprinted generating sentinel", () => {
    const sentinel = {
      version: 2,
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
        version: 2,
        status: "generating",
        startedAt: "2026-04-30T12:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parsePersistedDecisionAnalysis({
        version: 2,
        status: "generating",
        startedAt: "2026-04-30T12:00:00.000Z",
        inputFingerprint: "",
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
