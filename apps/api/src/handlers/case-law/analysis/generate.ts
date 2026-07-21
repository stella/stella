/**
 * Generate AI analysis for a court decision.
 *
 * Returns cached analysis if available. Otherwise kicks off
 * background generation and returns 202. The frontend polls
 * until the analysis is ready.
 */

import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import type {
  AnalysisHeading,
  DecisionAnalysis,
  PersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";
import {
  analysisHeadingSchema,
  isAnalysisInProgress,
  isAnalysisGenerating,
  isDecisionAnalysis,
  parsePersistedDecisionAnalysis,
} from "@stll/legal-ast/analysis";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { hasUsableAst } from "@stll/legal-ast/document-ast";

// SAFETY: rootDb is used only inside runGeneration, which runs in
// a fire-and-forget background task after the request scope has
// ended.
// eslint-disable-next-line no-restricted-imports -- background task outlives the request scope; no ctx.scopedDb available
import { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { detached } from "@/api/lib/detached";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import {
  getTanStackTextModelForRole,
  requireTanStackAIAvailableForRole,
} from "@/api/lib/tanstack-ai-models";

import { normalizeAnalysisHeadingLabels } from "./category-catalog";
import { formatDecisionForPrompt } from "./prompts/base";
import { getSystemPrompt } from "./prompts/prompt-registry";

const SENTINEL_STALE_MS = 5 * 60 * 1000;

type StreamedAnalysisHeading = Omit<AnalysisHeading, "children">;

const analysisOutputSchema = v.strictObject({
  headings: v.array(analysisHeadingSchema),
});

const createAnalysisHeading = ({
  heading,
  language,
}: {
  heading: StreamedAnalysisHeading;
  language: string;
}): AnalysisHeading =>
  normalizeAnalysisHeadingLabels({
    heading: {
      id: Bun.randomUUIDv7(),
      label: heading.label,
      category: heading.category,
      startAnchorId: heading.startAnchorId,
      endAnchorId: heading.endAnchorId,
      annotations: heading.annotations.map((annotation) => ({
        id: Bun.randomUUIDv7(),
        summary: annotation.summary,
        startAnchorId: annotation.startAnchorId,
        endAnchorId: annotation.endAnchorId,
        textSnippet: annotation.textSnippet,
      })),
      children: [],
    },
    language,
  });

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
const runGeneration = async (
  decisionId: SafeId<"caseLawDecision">,
  ast: DocumentAst,
  decision: {
    court: string;
    country: string;
    language: string;
    decisionType: string | null;
  },
  organizationId: SafeId<"organization">,
  orgAIConfig: OrgAIConfig | null,
  promptCachingEnabled: boolean,
) => {
  // audit: skip — background AI analysis output
  const systemPrompt = getSystemPrompt(decision.language);
  const decisionText = formatDecisionForPrompt(ast.blocks);

  const userMessage = `Court: ${decision.court}
Country: ${decision.country}
Type: ${decision.decisionType ?? "unknown"}

${decisionText}`;

  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "case-law.analysis",
    modelRole: "fast",
    orgAIConfig,
    properties: {
      decision_id: decisionId,
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
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        role: "fast",
        scopeKey: decisionId,
      }),
      system: systemPrompt,
      prompt: userMessage,
      outputSchema: analysisOutputSchema,
      abortSignal: AbortSignal.timeout(120_000),
    });

    // Assign stable IDs at push time so they don't change across persists
    const headings = result.headings.map((heading) =>
      createAnalysisHeading({
        heading,
        language: decision.language,
      }),
    );

    // Final persist without status marker
    const finalTree = headings;
    const analysis: DecisionAnalysis = {
      version: 1,
      generatedAt: new Date().toISOString(),
      model: modelId,
      tree: finalTree,
    };

    // Use rootDb (not scopedDb) because case-law analysis is global,
    // not workspace-scoped.
    await rootDb
      .update(caseLawDecisions)
      .set({ analysis })
      .where(eq(caseLawDecisions.id, decisionId));
  } catch (error) {
    captureError(error, {
      source: "case-law-analysis",
      decisionId,
    });
    aiAnalytics.captureError(error);
    await rootDb
      .update(caseLawDecisions)
      .set({ analysis: null })
      .where(eq(caseLawDecisions.id, decisionId))
      .catch(() => {
        // Best-effort sentinel cleanup; swallow to avoid
        // losing the original failure from the outer catch.
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
  promptCachingEnabled: boolean,
): Promise<Result<GenerateAnalysisResponse, HandlerError>> => {
  // audit: skip — background AI analysis output
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        id: true,
        language: true,
        court: true,
        country: true,
        decisionType: true,
        documentAst: true,
        analysis: true,
      },
    }),
  );

  if (!decision) {
    return Result.ok({ status: "error", error: "Decision not found" });
  }

  const analysis = parsePersistedDecisionAnalysis(decision.analysis);

  // Return cached analysis (complete or partial with progress)
  if (isAnalysisInProgress(analysis)) {
    return Result.ok({ status: "generating", analysis });
  }

  if (isDecisionAnalysis(analysis)) {
    return Result.ok({ status: "done", analysis });
  }

  // Concurrent generation guard for the lightweight sentinel without a tree.
  if (isAnalysisGenerating(analysis)) {
    const startedAt = new Date(analysis.startedAt).getTime();
    if (Date.now() - startedAt < SENTINEL_STALE_MS) {
      return Result.ok({ status: "generating" });
    }
  }

  // AI availability is checked only on the path that actually invokes the
  // model: the cached/in-flight reads above must stay accessible when the
  // fast role is unavailable (a pre-existing bug ran this check before them,
  // locking finished analyses behind AI configuration).
  const available = requireTanStackAIAvailableForRole({
    orgConfig: orgAIConfig,
    role: "fast",
  });
  if (Result.isError(available)) {
    return Result.err(available.error);
  }

  // Check AST
  if (!hasUsableAst(decision.documentAst)) {
    return Result.ok({
      status: "error",
      error: "Decision has no parseable AST",
    });
  }

  // hasUsableAst narrows to DocumentAst.
  const ast = decision.documentAst;

  // Set sentinel atomically (WHERE analysis IS NULL prevents TOCTOU race)
  const [updated] = await rootDb
    .update(caseLawDecisions)
    .set({
      analysis: {
        version: 1,
        status: "generating",
        startedAt: new Date().toISOString(),
      },
    })
    .where(
      and(
        eq(caseLawDecisions.id, decisionId),
        isNull(caseLawDecisions.analysis),
      ),
    )
    .returning({ id: caseLawDecisions.id });

  // Another request won the race — return generating
  if (!updated) {
    return Result.ok({ status: "generating" });
  }

  // Fire-and-forget generation
  detached(
    runGeneration(
      decisionId,
      ast,
      decision,
      organizationId,
      orgAIConfig,
      promptCachingEnabled,
    ),
    "generateAnalysis",
  );

  return Result.ok({ status: "generating" });
};

const config = {
  permissions: { workspace: ["read"] },
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
    promptCachingEnabled,
  }) {
    // AI availability is enforced inside generateAnalysis, after its cached
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
            promptCachingEnabled,
          ),
      ),
    );

    return response;
  },
);

export default generateDecisionAnalysis;
