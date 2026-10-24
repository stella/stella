import { Result } from "better-result";
/**
 * Filling the significance layer, lazily, when a reader opens a decision.
 *
 * The layer is fenced on the citation graph, not the document, so nothing
 * about the document can tell it is stale. This runs on the read path
 * instead: one indexed pass over the decision's cited-by set, a fingerprint
 * over it, and a model call only where the stored statement does not name
 * that fingerprint. A decision nobody opens is never analysed for
 * significance, and one nobody cites anew is analysed once.
 */

import type {
  DecisionAnalysis,
  DecisionAnalysisV4,
} from "@stll/legal-ast/analysis";
import { isSignificanceCurrent } from "@stll/legal-ast/analysis";
import { Temporal } from "@stll/time";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { analysisStore } from "@/api/lib/case-law/analysis-store";
import type { AnalysisStore } from "@/api/lib/case-law/analysis-store";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { ModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import {
  getTanStackTextModelInfoForTask,
  requireTanStackAIAvailableForTask,
} from "@/api/lib/tanstack-ai-models";

import {
  graphFingerprintOf,
  readCitationGraphFacts,
  SIGNIFICANCE_PROMPT_VERSION,
  significanceOutputSchema,
  significanceSystemPrompt,
  significanceUserMessage,
} from "./significance";
import type { CitationGraphFacts } from "./significance";

/**
 * Runs in flight in this process, keyed by the decision and the graph they
 * were started for. Two readers opening the same decision at the same
 * moment must cost one model call, not two; a third opening it after the
 * graph moved is a different key and does start a run.
 */
const inFlight = new Set<string>();

const SIGNIFICANCE_NONE_SAVE_FAILED_SINK = failureSink({
  event: "case_law.analysis.significance_none_save_failed",
  expected: [],
});

type RefreshSignificanceOptions = {
  /** Admits the refresh only once it is known to call the model. */
  admitModelAction: ModelActionAdmitter;
  decisionId: SafeId<"caseLawDecision">;
  /** The finished analysis on the row; its layers are kept verbatim. */
  analysis: DecisionAnalysis;
  /** The row's `contentHash`; the save is fenced on it, as every save is. */
  contentHash: string | null;
  /**
   * Whether this deployment may ask a model for derived layers
   * (`writesDerivedAnalyses`). Required, so no caller can start a refresh
   * without having made that decision.
   */
  derivedAi: boolean;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  promptCachingEnabled: boolean;
  /** Reads the decision's cited-by graph; tests answer it without a database. */
  readGraphFacts?: (
    decisionId: SafeId<"caseLawDecision">,
  ) => Promise<CitationGraphFacts | null>;
  store?: AnalysisStore;
};

const readPublicGraphFacts = async (decisionId: SafeId<"caseLawDecision">) =>
  await caseLawPublicReadDb(
    async (tx) => await readCitationGraphFacts({ decisionId, tx }),
  );

/** Only a version 4 analysis has a slot to write the statement into. */
const asV4 = (analysis: DecisionAnalysis): DecisionAnalysisV4 | null =>
  analysis.version === 4 ? analysis : null;

export const refreshSignificance = async ({
  admitModelAction,
  analysis,
  contentHash,
  decisionId,
  derivedAi,
  orgAIConfig,
  orgAIConfigStatus,
  organizationId,
  promptCachingEnabled,
  readGraphFacts = readPublicGraphFacts,
  store = analysisStore(),
}: RefreshSignificanceOptions): Promise<void> => {
  // First, before the graph is read: a deployment that may not ask a model
  // pays for nothing here.
  if (!derivedAi) {
    return;
  }
  const current = asV4(analysis);
  if (current === null) {
    return;
  }
  const facts = await readGraphFacts(decisionId);
  if (facts === null) {
    return;
  }
  const graphFingerprint = graphFingerprintOf(facts);
  // No later decision cites this one: the graph already says so, so `none` is
  // stored without asking a model, and a statement an earlier run wrote over
  // the empty graph is replaced by it.
  if (facts.citedByCount === 0) {
    if (
      current.significance?.kind === "none" &&
      current.significance.graphFingerprint === graphFingerprint
    ) {
      return;
    }
    const saved = await Result.tryPromise(
      async () =>
        await store.save({
          analysis: {
            ...current,
            significance: {
              kind: "none",
              graphFingerprint,
              generatedAt: Temporal.Now.instant().toString({
                fractionalSecondDigits: 3,
              }),
            },
          },
          contentHash,
          decisionId,
          expected: analysis,
        }),
    );
    if (Result.isError(saved)) {
      observeFailure(saved.error, {
        sink: SIGNIFICANCE_NONE_SAVE_FAILED_SINK,
        ctx: { decisionId },
      });
    }
    return;
  }
  // Only the positive-citation path needs an available classify model. The
  // empty graph above is corpus-wide state and can be stored for every reader.
  if (
    Result.isError(
      requireTanStackAIAvailableForTask({
        dataClass: "public_corpus",
        configStatus: orgAIConfigStatus,
        orgConfig: orgAIConfig,
        task: "classify",
      }),
    )
  ) {
    return;
  }
  if (
    isSignificanceCurrent({
      analysis: current,
      graphFingerprint,
      promptVersion: SIGNIFICANCE_PROMPT_VERSION,
    })
  ) {
    return;
  }

  const key = `${decisionId}:${graphFingerprint}`;
  if (inFlight.has(key)) {
    return;
  }
  inFlight.add(key);

  const language = current.holding.language;
  // Built once admission states the tier; absent when admission refused.
  let aiAnalytics:
    | ReturnType<typeof createTanStackAIAnalyticsCallbacks>
    | undefined;
  const written = await admitModelAction(async ({ admission }) => {
    aiAnalytics = createTanStackAIAnalyticsCallbacks({
      dataClass: "public_corpus",
      feature: "case-law.analysis.significance",
      modelTask: "classify",
      organizationId,
      orgAIConfig,
      modelTier: admission.modelTier,
      properties: {
        decision_id: decisionId,
        cited_by_count: facts.citedByCount,
        language,
        organization_id: organizationId,
      },
      sessionId: decisionId,
      traceId: Bun.randomUUIDv7(),
    });
    const { modelId } = getTanStackTextModelInfoForTask(
      "classify",
      orgAIConfig,
      {
        dataClass: "public_corpus",
        organizationId,
        modelTier: admission.modelTier,
      },
    );
    const result = await generateTanStackObjectForTask({
      userId: admission.userId,
      dataClass: "public_corpus",
      task: "classify",
      serviceTier: "standard",
      orgAIConfig,
      organizationId,
      admission,
      // Corpus-wide state, not a tenant's: the same decision serves everyone.
      tenantWorkspaceIds: [],
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        task: "classify",
        scopeKey: decisionId,
      }),
      system: significanceSystemPrompt(language),
      prompt: significanceUserMessage(facts),
      outputSchema: significanceOutputSchema,
      deadlineMs: 60_000,
    });

    // The document layers are carried over untouched: this run read the
    // graph, not the text, and has nothing to say about them.
    //
    // Fenced on the exact value this run started from. Two runs over the
    // same document differ only in the graph they saw, which the store's
    // fingerprint and content-hash fences cannot tell apart, so a run that
    // began on an older graph and finished last would otherwise overwrite
    // the newer statement and put the decision back in the queue. Here it
    // simply loses.
    await store.save({
      analysis: {
        ...current,
        significance: {
          text: result.significance,
          language,
          graphFingerprint,
          generatedAt: Temporal.Now.instant().toString({
            fractionalSecondDigits: 3,
          }),
          model: modelId,
          promptVersion: SIGNIFICANCE_PROMPT_VERSION,
        },
      },
      contentHash,
      decisionId,
      expected: analysis,
    });
  });

  inFlight.delete(key);

  // A refused action is an expected outcome: the statement waits for a reader
  // whose organization has an action to spend.
  if (Result.isError(written) && !ActionAdmissionError.is(written.error)) {
    // A reader is already looking at the document layers; the graph one
    // simply does not appear this time. Captured, never swallowed.
    captureError(written.error, {
      source: "case-law-analysis-significance",
      decisionId,
    });
    aiAnalytics?.captureError(written.error);
  }
};
