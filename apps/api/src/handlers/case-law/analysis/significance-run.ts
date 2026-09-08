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

import { Result } from "better-result";

import type {
  DecisionAnalysis,
  DecisionAnalysisV3,
} from "@stll/legal-ast/analysis";
import { isSignificanceCurrent } from "@stll/legal-ast/analysis";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import {
  getTanStackTextModelForRole,
  requireTanStackAIAvailableForRole,
} from "@/api/lib/tanstack-ai-models";

import { analysisStore } from "./analysis-store";
import {
  graphFingerprintOf,
  readCitationGraphFacts,
  significanceOutputSchema,
  significanceSystemPrompt,
  significanceUserMessage,
  SIGNIFICANCE_PROMPT_VERSION,
} from "./significance";

/**
 * Runs in flight in this process, keyed by the decision and the graph they
 * were started for. Two readers opening the same decision at the same
 * moment must cost one model call, not two; a third opening it after the
 * graph moved is a different key and does start a run.
 */
const inFlight = new Set<string>();

type RefreshSignificanceOptions = {
  decisionId: SafeId<"caseLawDecision">;
  /** The finished analysis on the row; its layers are kept verbatim. */
  analysis: DecisionAnalysis;
  /** The row's `contentHash`; the save is fenced on it, as every save is. */
  contentHash: string | null;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  promptCachingEnabled: boolean;
};

/** Only a version 3 analysis has a slot to write the statement into. */
const asV3 = (analysis: DecisionAnalysis): DecisionAnalysisV3 | null =>
  analysis.version === 3 ? analysis : null;

export const refreshSignificance = async ({
  analysis,
  contentHash,
  decisionId,
  orgAIConfig,
  orgAIConfigStatus,
  organizationId,
  promptCachingEnabled,
}: RefreshSignificanceOptions): Promise<void> => {
  const current = asV3(analysis);
  if (current === null) {
    return;
  }
  // Checked before the graph is read: an org with no fast model available
  // must not pay for the query either.
  if (
    Result.isError(
      requireTanStackAIAvailableForRole({
        configStatus: orgAIConfigStatus,
        orgConfig: orgAIConfig,
        role: "fast",
      }),
    )
  ) {
    return;
  }

  const facts = await caseLawPublicReadDb(
    async (tx) => await readCitationGraphFacts({ decisionId, tx }),
  );
  if (facts === null) {
    return;
  }
  const graphFingerprint = graphFingerprintOf(facts);
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
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "case-law.analysis.significance",
    modelRole: "fast",
    organizationId,
    orgAIConfig,
    properties: {
      decision_id: decisionId,
      cited_by_count: facts.citedByCount,
      language,
      organization_id: organizationId,
    },
    sessionId: decisionId,
    traceId: Bun.randomUUIDv7(),
  });

  const written = await Result.tryPromise(async () => {
    const { modelId } = getTanStackTextModelForRole("fast", orgAIConfig, {
      organizationId,
    });
    const result = await generateTanStackObjectForRole({
      role: "fast",
      serviceTier: "standard",
      orgAIConfig,
      organizationId,
      // Corpus-wide state, not a tenant's: the same decision serves everyone.
      tenantWorkspaceIds: [],
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        role: "fast",
        scopeKey: decisionId,
      }),
      system: significanceSystemPrompt(language),
      prompt: significanceUserMessage(facts),
      outputSchema: significanceOutputSchema,
      abortSignal: AbortSignal.timeout(60_000),
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
    await analysisStore().save({
      analysis: {
        ...current,
        significance: {
          text: result.significance,
          language,
          graphFingerprint,
          generatedAt: new Date().toISOString(),
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

  if (Result.isError(written)) {
    // A reader is already looking at the document layers; the graph one
    // simply does not appear this time. Captured, never swallowed.
    captureError(written.error, {
      source: "case-law-analysis-significance",
      decisionId,
    });
    aiAnalytics.captureError(written.error);
  }
};
