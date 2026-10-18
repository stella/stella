import { describe, expect, test } from "bun:test";

import type {
  AnalysisHeading,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";

import { toSafeId } from "@/api/lib/branded-types";
import { analysisFailureRecord } from "@/api/lib/case-law/analysis-failure";
import { createMemoryAnalysisStore } from "@/api/lib/case-law/analysis-store";
import { storedAnalysisState } from "@/api/lib/case-law/stored-analysis";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "00000000-0000-0000-0000-0000000000a1",
);
const FINGERPRINT = "f".repeat(64);
const FIRST_STARTED_AT = new Date("2026-10-18T12:00:00.000Z");
const SECOND_STARTED_AT = new Date("2026-10-18T12:00:01.000Z");

const section = {
  id: "h1",
  label: "Reasoning",
  category: "reasoning",
  startAnchorId: "b1",
  endAnchorId: "b2",
  annotations: [],
  children: [],
} satisfies AnalysisHeading;

const finishedAnalysis = {
  version: 3,
  generatedAt: "2026-10-18T12:00:02.000Z",
  model: "test/model",
  inputFingerprint: FINGERPRINT,
  tree: [section],
  holding: { text: "The appeal was dismissed.", language: "en", anchors: [] },
  abstract: { text: "The court dismissed the appeal.", language: "en" },
  topics: ["appeal"],
} satisfies DecisionAnalysis;

const progress = (stored: unknown) => {
  const state = storedAnalysisState({
    stored,
    fingerprint: FINGERPRINT,
    now: SECOND_STARTED_AT,
  });
  if (state.kind !== "generating") {
    return state;
  }
  return {
    status: "generating" as const,
    ...(state.partialTree.length === 0
      ? {}
      : { partialTree: state.partialTree }),
  };
};

const claim = async (
  store: ReturnType<typeof createMemoryAnalysisStore>,
  observed: unknown,
) => {
  const sentinel = await store.claim({
    decisionId: DECISION_ID,
    fingerprint: FINGERPRINT,
    observed,
  });
  expect(sentinel).not.toBeNull();
  if (sentinel === null) {
    throw new Error("expected the analysis run to claim the decision");
  }
  return sentinel;
};

describe("streamed case-law analysis", () => {
  test("GET progress includes a section published by the active run", async () => {
    const store = createMemoryAnalysisStore(() => FIRST_STARTED_AT);
    const sentinel = await claim(store, null);

    expect(
      await store.savePartial({
        decisionId: DECISION_ID,
        partialTree: [section],
        sentinel,
      }),
    ).toBe(true);
    expect(progress(store.peek(DECISION_ID))).toEqual({
      status: "generating",
      partialTree: [section],
    });
  });

  test("a replaced run cannot publish or clear its successor's progress", async () => {
    const startedAt = [FIRST_STARTED_AT, SECOND_STARTED_AT];
    const store = createMemoryAnalysisStore(() => {
      const next = startedAt.shift();
      if (next === undefined) {
        throw new Error("unexpected third claim");
      }
      return next;
    });
    const original = await claim(store, null);
    const replacement = await claim(store, store.peek(DECISION_ID));
    expect(replacement.startedAt).not.toBe(original.startedAt);
    expect(
      await store.savePartial({
        decisionId: DECISION_ID,
        partialTree: [section],
        sentinel: replacement,
      }),
    ).toBe(true);
    const replacementProgress = store.peek(DECISION_ID);

    expect(
      await store.savePartial({
        decisionId: DECISION_ID,
        partialTree: [],
        sentinel: original,
      }),
    ).toBe(false);
    await store.fail({
      decisionId: DECISION_ID,
      failure: analysisFailureRecord({
        code: "failed",
        fingerprint: FINGERPRINT,
        now: SECOND_STARTED_AT,
        reader: { source: "platform" },
      }),
      keyTag: "platform",
      sentinel: original,
    });

    expect(store.peek(DECISION_ID)).toBe(replacementProgress);
    expect(progress(store.peek(DECISION_ID))).toEqual({
      status: "generating",
      partialTree: [section],
    });
  });

  test("a successful final save replaces progress with a done analysis", async () => {
    const store = createMemoryAnalysisStore(() => FIRST_STARTED_AT);
    const sentinel = await claim(store, null);
    expect(
      await store.savePartial({
        decisionId: DECISION_ID,
        partialTree: [section],
        sentinel,
      }),
    ).toBe(true);

    expect(
      await store.save({
        analysis: finishedAnalysis,
        contentHash: null,
        decisionId: DECISION_ID,
      }),
    ).toBe(true);
    expect(
      storedAnalysisState({
        stored: store.peek(DECISION_ID),
        fingerprint: FINGERPRINT,
        now: SECOND_STARTED_AT,
      }),
    ).toEqual({ kind: "done", analysis: finishedAnalysis });
    expect(store.peek(DECISION_ID)).not.toHaveProperty("partialTree");
  });
});
