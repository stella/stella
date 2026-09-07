/**
 * Generate AI analysis for a court decision.
 *
 * Returns the stored analysis when it was computed over the document as
 * it reads today. Otherwise kicks off background generation and returns
 * 202. The frontend polls until the analysis is ready.
 */

import { panic, Result } from "better-result";
import { t } from "elysia";

import type {
  AnalysisGenerating,
  PersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";

import type { ScopedDb } from "@/api/db/safe-db";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import type { AnalysisInput } from "@/api/lib/case-law/analysis-prompt";
import { tSafeId } from "@/api/lib/custom-schema";
import { detached } from "@/api/lib/detached";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import {
  getTanStackTextModelForRole,
  requireTanStackAIAvailableForRole,
} from "@/api/lib/tanstack-ai-models";

import { resolveAnalysisInput } from "./analysis-input";
import { analysisOutputSchema, buildDecisionAnalysis } from "./analysis-output";
import { analysisStore, storesAnalyses } from "./analysis-store";
import { allowsDerivedAiAnalysis } from "./analysis-update";
import { refreshSignificance } from "./significance-run";
import { storedAnalysisState } from "./stored-analysis";

/**
 * Run the AI generation in the background. Updates the DB
 * when done; clears the sentinel on failure.
 *
 * `orgAIConfig` is captured from the request scope and threaded
 * through here so BYOK orgs route this fire-and-forget call to
 * their own provider key. Snapshot semantics are intentional: a
 * config change made during the in-flight generation does not
 * retarget mid-run.
 */
type RunGenerationOptions = {
  decisionId: SafeId<"caseLawDecision">;
  input: AnalysisInput;
  country: string;
  /** The row's `contentHash` at claim time; the save is fenced on it. */
  contentHash: string | null;
  /** The sentinel the claim wrote; cleanup releases exactly this one. */
  sentinel: AnalysisGenerating;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
};

const runGeneration = async ({
  contentHash,
  country,
  decisionId,
  input,
  orgAIConfig,
  organizationId,
  promptCachingEnabled,
  sentinel,
}: RunGenerationOptions) => {
  // audit: skip — background AI analysis output
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "case-law.analysis",
    modelRole: "fast",
    organizationId,
    orgAIConfig,
    properties: {
      decision_id: decisionId,
      jurisdiction: country,
      language: input.language,
      organization_id: organizationId,
    },
    sessionId: decisionId,
    traceId: Bun.randomUUIDv7(),
  });

  try {
    const { modelId } = getTanStackTextModelForRole("fast", orgAIConfig, {
      organizationId,
    });
    const result = await generateTanStackObjectForRole({
      role: "fast",
      serviceTier: "standard",
      orgAIConfig,
      organizationId,
      // Case-law analysis is global, not workspace-scoped (see the store).
      tenantWorkspaceIds: [],
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        role: "fast",
        scopeKey: decisionId,
      }),
      system: input.systemPrompt,
      prompt: input.userMessage,
      outputSchema: analysisOutputSchema,
      abortSignal: AbortSignal.timeout(120_000),
    });

    const analysis = buildDecisionAnalysis({
      output: result,
      language: input.language,
      model: modelId,
      inputFingerprint: input.fingerprint,
      generatedAt: new Date(),
    });

    await analysisStore().save({ analysis, contentHash, decisionId });
  } catch (error) {
    captureError(error, {
      source: "case-law-analysis",
      decisionId,
    });
    aiAnalytics.captureError(error);
    await analysisStore()
      .clear({ decisionId, sentinel })
      .catch((cleanupError: unknown) => {
        // Best-effort sentinel cleanup. Capture rather than swallow: a
        // failure here leaves the decision pinned in the generating state,
        // which is a distinct fault from the one the outer catch reported.
        captureError(cleanupError, {
          source: "case-law-analysis-sentinel-cleanup",
          decisionId,
        });
      });
  }
};

type GenerateAnalysisResponse = {
  status: "done" | "error" | "generating";
  analysis?: PersistedDecisionAnalysis;
  error?: string;
};

export const generateAnalysis = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
  orgAIConfig: OrgAIConfig | null,
  orgAIConfigStatus: OrgAIConfigStatus,
  promptCachingEnabled: boolean,
): Promise<Result<GenerateAnalysisResponse, HandlerError>> => {
  // audit: skip — background AI analysis output
  const resolution = await resolveAnalysisInput({ decisionId, scopedDb });
  switch (resolution.kind) {
    case "decision-not-found":
      return Result.ok({ status: "error", error: "Decision not found" });
    case "unparseable-document":
      return Result.ok({
        status: "error",
        error: "Decision has no parseable AST",
      });
    case "resolved":
      break;
    default: {
      resolution satisfies never;
      return panic(`Unhandled resolution: ${String(resolution)}`);
    }
  }
  const { decision, input } = resolution;

  const observed = analysisStore().peek(decisionId) ?? decision.analysis;
  const stored = storedAnalysisState({
    stored: observed,
    fingerprint: input.fingerprint,
    now: new Date(),
  });
  switch (stored.kind) {
    case "done":
      // The document layers are settled; the graph one may not be. Fenced
      // on the citation graph and written in the background, so a reader
      // never waits for it and a decision whose neighbourhood has not
      // moved costs one indexed query.
      if (storesAnalyses()) {
        detached(
          refreshSignificance({
            analysis: stored.analysis,
            contentHash: decision.contentHash,
            decisionId,
            orgAIConfig,
            orgAIConfigStatus,
            organizationId,
            promptCachingEnabled,
          }),
          "analysis-generate.refresh-significance",
        );
      }
      return Result.ok({ status: "done", analysis: stored.analysis });
    case "generating":
      return Result.ok({ status: "generating" });
    case "none":
      break;
    default: {
      stored satisfies never;
      return panic(`Unhandled stored: ${String(stored)}`);
    }
  }

  if (!storesAnalyses()) {
    return Result.ok({
      status: "error",
      error: "Analysis is unavailable for this decision",
    });
  }

  // Sources carry different reuse terms. One whose terms withhold derived AI
  // use is still read and served; its text is never sent to a model. Decided
  // before AI availability because it is a property of the decision, not of
  // how this deployment is configured.
  if (!allowsDerivedAiAnalysis(decision)) {
    return Result.ok({
      status: "error",
      error: "Analysis is unavailable for this decision",
    });
  }

  // AI availability is checked only on the path that actually invokes the
  // model: the stored and in-flight reads above must stay accessible when
  // the fast role is unavailable (a pre-existing bug ran this check before
  // them, locking finished analyses behind AI configuration).
  const available = requireTanStackAIAvailableForRole({
    configStatus: orgAIConfigStatus,
    orgConfig: orgAIConfig,
    role: "fast",
  });
  if (Result.isError(available)) {
    return Result.err(available.error);
  }

  // Another request won the race: return generating.
  const sentinel = await analysisStore().claim({
    decisionId,
    fingerprint: input.fingerprint,
    observed,
  });
  if (sentinel === null) {
    return Result.ok({ status: "generating" });
  }

  // Fire-and-forget generation
  detached(
    runGeneration({
      contentHash: decision.contentHash,
      country: decision.country,
      decisionId,
      input,
      orgAIConfig,
      organizationId,
      promptCachingEnabled,
      sentinel,
    }),
    "analysis-generate.run-generation",
  );

  return Result.ok({ status: "generating" });
};

const config = {
  description:
    "Read the structural analysis of one court decision, starting generation " +
    "when there is none yet. Returns status done with the stored analysis, " +
    "generating while a run is in flight (poll until it is done), or error " +
    "when the decision is unknown or its text could not be parsed. " +
    "Generation runs in the background and a call made while one is already " +
    "running does not start a second.",
  permissions: { workspace: ["read"], chat: ["create"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  // Writes a "generating" sentinel and kicks off background AI generation
  // that updates the decision row.
  access: "write",
  params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
} satisfies HandlerConfig;

const generateDecisionAnalysis = createSafeRootHandler(
  config,
  async function* ({
    params: { decisionId },
    session,
    scopedDb,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
  }) {
    // AI availability is enforced inside generateAnalysis, after its stored
    // and in-flight branches, so finished analyses stay readable when the
    // fast model role is unavailable.
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await generateAnalysis(
            decisionId,
            scopedDb,
            session.activeOrganizationId,
            orgAIConfig,
            orgAIConfigStatus,
            promptCachingEnabled,
          ),
      ),
    );

    return response;
  },
);

export default generateDecisionAnalysis;
