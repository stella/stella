import { describe, expect, test } from "bun:test";

import {
  isAnalysisInProgress,
  isDecisionAnalysis,
  parsePersistedDecisionAnalysis,
} from "./analysis";
import type { AnalysisInProgress } from "./analysis";

describe("parsePersistedDecisionAnalysis", () => {
  test("keeps versioned generating analysis payloads", () => {
    const analysis = {
      version: 1,
      status: "generating",
      startedAt: "2026-04-30T12:00:00.000Z",
    } as const;

    expect(parsePersistedDecisionAnalysis(analysis)).toEqual(analysis);
  });

  test("rejects unversioned generating sentinels", () => {
    expect(
      parsePersistedDecisionAnalysis({
        status: "generating",
        startedAt: "2026-04-30T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("returns the canonical parsed payload instead of the raw object", () => {
    expect(
      parsePersistedDecisionAnalysis({
        version: 1,
        generatedAt: "2026-04-30T12:00:00.000Z",
        model: "test-model",
        tree: [
          {
            id: "h1",
            label: "Heading",
            category: "facts",
            startAnchorId: "a1",
            endAnchorId: "a2",
            annotations: [],
            children: [],
            staleProducerField: true,
          },
        ],
      }),
    ).toEqual({
      version: 1,
      generatedAt: "2026-04-30T12:00:00.000Z",
      model: "test-model",
      tree: [
        {
          id: "h1",
          label: "Heading",
          category: "facts",
          startAnchorId: "a1",
          endAnchorId: "a2",
          annotations: [],
          children: [],
        },
      ],
    });
  });

  test("rejects a decision analysis with malformed headings", () => {
    const malformed = {
      version: 1,
      generatedAt: "2026-04-30T12:00:00.000Z",
      model: "test-model",
      tree: [{ id: "missing-required-fields" }],
    };

    expect(isDecisionAnalysis(malformed)).toBe(false);
    expect(parsePersistedDecisionAnalysis(malformed)).toBeNull();
  });

  test("requires recursively complete children for persisted headings", () => {
    const malformed = {
      version: 1,
      generatedAt: "2026-04-30T12:00:00.000Z",
      model: "test-model",
      tree: [
        {
          id: "h1",
          label: "Heading",
          category: "facts",
          startAnchorId: "a1",
          endAnchorId: "a2",
          annotations: [],
          children: [{ id: "incomplete-child" }],
        },
      ],
    };

    expect(isDecisionAnalysis(malformed)).toBe(false);
    expect(
      parsePersistedDecisionAnalysis(JSON.stringify(malformed)),
    ).toBeNull();
  });

  test("validates complete in-progress analysis trees", () => {
    const inProgress: AnalysisInProgress = {
      version: 1,
      generatedAt: "2026-04-30T12:00:00.000Z",
      model: "test-model",
      status: "generating",
      tree: [
        {
          id: "h1",
          label: "Heading",
          category: "facts",
          startAnchorId: "a1",
          endAnchorId: "a2",
          annotations: [],
          children: [],
        },
      ],
    };

    expect(isAnalysisInProgress(inProgress)).toBe(true);
    expect(parsePersistedDecisionAnalysis(inProgress)).toEqual(inProgress);
  });
});
