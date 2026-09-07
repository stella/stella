/**
 * Every fence a stored analysis stands on, driven directly.
 *
 * An analysis is only worth storing if it describes the decision as it reads
 * now, and only one writer may store it at a time. These are the cases that
 * decide both, for the in-app run and for the operator script alike.
 */

import { describe, expect, test } from "bun:test";

import type {
  DecisionAnalysis,
  DecisionAnalysisV3,
} from "@stll/legal-ast/analysis";

import { toSafeId } from "@/api/lib/branded-types";
import type { AnalysisInput } from "@/api/lib/case-law/analysis-prompt";

import type { AnalysisOutput } from "./analysis-output";
import type { AnalysisStore } from "./analysis-store-core";
import {
  applyAnalysisUpdate,
  type AnalysisSubject,
  type AnalysisUpdateFences,
} from "./analysis-update";
import { analysisSentinel } from "./stored-analysis";

const DECISION_ID = toSafeId<"caseLawDecision">(
  "00000000-0000-0000-0000-0000000000a1",
);
const FINGERPRINT = "f".repeat(64);
const CONTENT_HASH = "c".repeat(64);
const NOW = new Date("2026-09-01T12:00:00.000Z");

const OUTPUT: AnalysisOutput = {
  headings: [
    {
      id: "the-model-made-this-up",
      label: "Odůvodnění",
      category: "reasoning",
      startAnchorId: "b3",
      endAnchorId: "b9",
      annotations: [
        {
          id: "also-made-up",
          summary: "The court read the period as running from accrual.",
          startAnchorId: "b4",
          endAnchorId: "b4",
          textSnippet: "…",
        },
      ],
    },
  ],
  holding: {
    text: "A limitation period runs from the day the claim could first be brought.",
    anchors: [{ startAnchorId: "b4", endAnchorId: "b5" }],
  },
  abstract:
    "The court answered the limitation question and dismissed the appeal.",
  topics: ["promlčení"],
};

const FENCES: AnalysisUpdateFences = {
  fingerprint: FINGERPRINT,
  contentHash: CONTENT_HASH,
  model: "some-provider/some-model",
};

const input: AnalysisInput = {
  language: "cs",
  systemPrompt: "system",
  userMessage: "user",
  fingerprint: FINGERPRINT,
};

const subject = ({
  allowsDerivedAi = true,
  analysis = null,
  contentHash = CONTENT_HASH,
  hasSource = true,
}: {
  allowsDerivedAi?: boolean;
  analysis?: unknown;
  contentHash?: string | null;
  hasSource?: boolean;
} = {}): AnalysisSubject => ({
  contentHash,
  analysis,
  source: hasSource
    ? {
        descriptor: {
          license: "public-domain",
          attribution: null,
          allowsRedistribution: true,
          allowsDerivedAi,
        },
      }
    : null,
});

type StoreCalls = {
  claims: number;
  saves: { analysis: DecisionAnalysis; contentHash: string | null }[];
};

const createStore = ({
  claimWins = true,
  held = null,
}: { claimWins?: boolean; held?: unknown } = {}) => {
  const calls: StoreCalls = { claims: 0, saves: [] };
  const store: AnalysisStore = {
    claim: async ({ fingerprint }) => {
      calls.claims += 1;
      return await Promise.resolve(
        claimWins ? analysisSentinel(fingerprint, NOW) : null,
      );
    },
    save: async ({ analysis, contentHash }) => {
      calls.saves.push({ analysis, contentHash });
      await Promise.resolve();
    },
    clear: async () => {
      await Promise.resolve();
    },
    peek: () => held,
  };
  return { calls, store };
};

const apply = async ({
  decision = subject(),
  store,
  submission = { ...FENCES, ...OUTPUT },
}: {
  decision?: AnalysisSubject;
  store: AnalysisStore;
  submission?: AnalysisUpdateFences & AnalysisOutput;
}) =>
  await applyAnalysisUpdate({
    decision,
    decisionId: DECISION_ID,
    input,
    now: NOW,
    store,
    submission,
  });

const storedAnalysis = (
  fingerprint: string = FINGERPRINT,
): DecisionAnalysisV3 => ({
  version: 3,
  generatedAt: "2026-08-01T00:00:00.000Z",
  model: "earlier-model",
  inputFingerprint: fingerprint,
  tree: [],
  holding: { text: "Earlier holding.", language: "cs", anchors: [] },
  abstract: { text: "Earlier abstract.", language: "cs" },
  topics: [],
});

describe("applyAnalysisUpdate", () => {
  test("stores the analysis, assigning ids and stamping the language", async () => {
    const { calls, store } = createStore();

    const outcome = await apply({ store });

    expect(outcome.kind).toBe("saved");
    if (outcome.kind !== "saved") {
      return;
    }
    expect(calls.claims).toBe(1);
    expect(calls.saves).toHaveLength(1);
    expect(calls.saves[0]?.contentHash).toBe(CONTENT_HASH);
    expect(outcome.analysis.version).toBe(3);
    expect(outcome.analysis.inputFingerprint).toBe(FINGERPRINT);
    expect(outcome.analysis.model).toBe("some-provider/some-model");
    expect(outcome.analysis.holding.language).toBe("cs");
    expect(outcome.analysis.abstract.language).toBe("cs");
    expect(outcome.analysis.topics).toEqual(["promlčení"]);
    // The producer's ids are never trusted: stella mints stable ones.
    expect(outcome.analysis.tree[0]?.id).not.toBe("the-model-made-this-up");
    expect(outcome.analysis.tree[0]?.annotations[0]?.id).not.toBe(
      "also-made-up",
    );
  });

  test("refuses a fingerprint the decision's input no longer digests to", async () => {
    const { calls, store } = createStore();

    const outcome = await apply({
      store,
      submission: { ...FENCES, ...OUTPUT, fingerprint: "0".repeat(64) },
    });

    expect(outcome.kind).toBe("stale-fingerprint");
    expect(calls.claims).toBe(0);
    expect(calls.saves).toHaveLength(0);
  });

  test("refuses a content hash the row no longer carries", async () => {
    const { calls, store } = createStore();

    const outcome = await apply({
      store,
      submission: { ...FENCES, ...OUTPUT, contentHash: "0".repeat(64) },
    });

    expect(outcome.kind).toBe("stale-content-hash");
    expect(calls.saves).toHaveLength(0);
  });

  test("refuses a decision whose source withholds derived AI use", async () => {
    const { calls, store } = createStore();

    const outcome = await apply({
      decision: subject({ allowsDerivedAi: false }),
      store,
    });

    expect(outcome.kind).toBe("derived-ai-refused");
    expect(calls.saves).toHaveLength(0);
  });

  // Unknown terms are not permissive terms: a decision with no source row
  // states nothing about reuse, so nothing is derived from it.
  test("refuses a decision with no source row at all", async () => {
    const { store } = createStore();

    expect(
      (await apply({ decision: subject({ hasSource: false }), store })).kind,
    ).toBe("derived-ai-refused");
  });

  test("refuses while an in-app run holds the row", async () => {
    const { calls, store } = createStore();

    const outcome = await apply({
      decision: subject({ analysis: analysisSentinel(FINGERPRINT, NOW) }),
      store,
    });

    expect(outcome.kind).toBe("run-in-flight");
    expect(calls.claims).toBe(0);
  });

  test("re-saving the same fingerprint is a no-op success", async () => {
    const stored = storedAnalysis();
    const { calls, store } = createStore();

    const outcome = await apply({
      decision: subject({ analysis: stored }),
      store,
    });

    expect(outcome.kind).toBe("unchanged");
    if (outcome.kind === "unchanged") {
      expect(outcome.analysis).toEqual(stored);
    }
    expect(calls.claims).toBe(0);
    expect(calls.saves).toHaveLength(0);
  });

  test("an analysis over a different input does not block the save", async () => {
    const { calls, store } = createStore();

    const outcome = await apply({
      decision: subject({ analysis: storedAnalysis("0".repeat(64)) }),
      store,
    });

    expect(outcome.kind).toBe("saved");
    expect(calls.claims).toBe(1);
  });

  test("reports a lost claim rather than writing over the winner", async () => {
    const { calls, store } = createStore({ claimWins: false });

    const outcome = await apply({ store });

    expect(outcome.kind).toBe("claim-lost");
    expect(calls.saves).toHaveLength(0);
  });

  test("prefers what the store holds over the row it was read from", async () => {
    // A development process keeps analyses in memory beside a read-only
    // row; the fence must read that, or a save would look unclaimed.
    const { calls, store } = createStore({ held: storedAnalysis() });

    const outcome = await apply({ store });

    expect(outcome.kind).toBe("unchanged");
    expect(calls.claims).toBe(0);
  });
});
