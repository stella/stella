/**
 * What happens to a computed analysis, decided in one place.
 *
 * Every refusal a writer can receive is a branch here, over the resolved
 * input, the value the row holds, and the store's own compare-and-swap.
 * The in-app generation run and the operator script that stores an analysis
 * computed elsewhere both go through it, so neither can acquire a fence the
 * other does not have.
 *
 * Deliberately free of env, connections and HTTP: it takes the decision as
 * a plain shape and the store as an argument, which is what lets the same
 * policy run inside the API and inside a script connecting as a restricted
 * database role.
 */

import { panic } from "better-result";

import type {
  DecisionAnalysis,
  DecisionAnalysisV3,
} from "@stll/legal-ast/analysis";

import type { SafeId } from "@/api/lib/branded-types";
import type { AnalysisInput } from "@/api/lib/case-law/analysis-prompt";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";

import { buildDecisionAnalysis, type AnalysisOutput } from "./analysis-output";
import type { AnalysisStore } from "./analysis-store-core";
import { storedAnalysisState } from "./stored-analysis";

/** As much of a decision row as writing an analysis depends on. */
export type AnalysisSubject = {
  /** The document behind the analysis; the save is fenced on it. */
  contentHash: string | null;
  /** The `analysis` column, exactly as read. */
  analysis: unknown;
  source: { descriptor: CorpusSourceDescriptor | null } | null;
};

/**
 * Whether this decision's text may reach a model at all. Sources carry
 * different reuse terms; one whose terms withhold derived AI use is still
 * read and served, its text is simply never analysed, by stella or by
 * anyone stella hands it to.
 */
export const allowsDerivedAiAnalysis = (decision: AnalysisSubject): boolean =>
  decision.source !== null && allowsDerivedAi(decision.source.descriptor);

/** What a writer submits, beside the layers themselves. */
export type AnalysisUpdateFences = {
  fingerprint: string;
  contentHash: string | null;
  model: string;
};

export type AnalysisUpdateOutcome =
  | { kind: "saved"; analysis: DecisionAnalysisV3 }
  /** An analysis over this very input is already stored: the retry is a no-op. */
  | { kind: "unchanged"; analysis: DecisionAnalysis }
  | { kind: "derived-ai-refused" }
  | { kind: "stale-fingerprint" }
  | { kind: "stale-content-hash" }
  | { kind: "run-in-flight" }
  /** The row changed between the read and the claim; the writer retries. */
  | { kind: "claim-lost" };

type ApplyAnalysisUpdateOptions = {
  decisionId: SafeId<"caseLawDecision">;
  decision: AnalysisSubject;
  /** The input the decision resolves to right now, not the one submitted. */
  input: AnalysisInput;
  /** Anchor ids of the parse behind that input, in reading order. */
  anchorIds: readonly string[];
  submission: AnalysisUpdateFences & AnalysisOutput;
  store: AnalysisStore;
  now: Date;
};

export const applyAnalysisUpdate = async ({
  anchorIds,
  decision,
  decisionId,
  input,
  now,
  store,
  submission,
}: ApplyAnalysisUpdateOptions): Promise<AnalysisUpdateOutcome> => {
  // The source's reuse terms, before anything derived from a model is
  // stored against the decision.
  if (!allowsDerivedAiAnalysis(decision)) {
    return { kind: "derived-ai-refused" };
  }

  // Both fences are re-derived from the live row, never taken on trust:
  // the fingerprint proves the analysis describes this parse of the text,
  // the content hash proves the document behind it has not been replaced.
  if (submission.fingerprint !== input.fingerprint) {
    return { kind: "stale-fingerprint" };
  }
  if (submission.contentHash !== decision.contentHash) {
    return { kind: "stale-content-hash" };
  }

  const observed = store.peek(decisionId) ?? decision.analysis;
  const stored = storedAnalysisState({
    stored: observed,
    fingerprint: input.fingerprint,
    now,
  });
  switch (stored.kind) {
    case "done":
      return { kind: "unchanged", analysis: stored.analysis };
    case "generating":
      return { kind: "run-in-flight" };
    case "none":
      break;
    default:
      stored satisfies never;
      return panic("Unhandled stored analysis state");
  }

  // Take the row the way a generation run takes it, so the two writers
  // serialise on one compare-and-swap instead of racing.
  const sentinel = await store.claim({
    decisionId,
    fingerprint: input.fingerprint,
    observed,
  });
  if (sentinel === null) {
    return { kind: "claim-lost" };
  }

  const analysis = buildDecisionAnalysis({
    anchorIds,
    output: submission,
    language: input.language,
    model: submission.model,
    inputFingerprint: input.fingerprint,
    generatedAt: now,
  });
  // The fences are `WHERE` clauses, so a row that moved between the claim
  // and this statement is a no-op, not an error. Reporting `saved` on a
  // write that touched nothing would hand the caller a false receipt.
  const wrote = await store.save({
    analysis,
    contentHash: decision.contentHash,
    decisionId,
  });
  return wrote ? { kind: "saved", analysis } : { kind: "claim-lost" };
};
