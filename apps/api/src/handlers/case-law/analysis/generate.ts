/**
 * Generate AI analysis for a court decision.
 *
 * Returns cached analysis if available. Otherwise kicks off
 * background generation and returns 202. The frontend polls
 * until the analysis is ready.
 */

import { Output, streamText } from "ai";
import { and, eq, isNull } from "drizzle-orm";

import type {
  AnalysisHeading,
  AnalysisInProgress,
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

import type { ScopedDb } from "@/api/db";
// SAFETY: rootDb is used only inside runGeneration, which runs in
// a fire-and-forget background task after the request scope has
// ended.
// eslint-disable-next-line no-restricted-imports
import { rootDb } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import { getModelForRole, getModelInfoForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import { captureError } from "@/api/lib/analytics";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import type { SafeId } from "@/api/lib/branded-types";

import { normalizeAnalysisHeadingLabels } from "./category-catalog";
import { formatDecisionForPrompt } from "./prompts/base";
import { getSystemPrompt } from "./prompts/index";

const SENTINEL_STALE_MS = 5 * 60 * 1000;

type StreamedAnalysisHeading = Omit<AnalysisHeading, "children">;

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

  const model = getModelForRole("fast", orgAIConfig, {
    promptCachingEnabled,
    scopeKey: decisionId,
    organizationId,
    serviceTier: "flex",
  });
  const { modelId } = getModelInfoForRole("fast", orgAIConfig);
  const aiAnalytics = createAIAnalyticsCallbacks({
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
    const result = streamText({
      model,
      output: Output.array({
        element: strictOutputSchema(analysisHeadingSchema),
      }),
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      abortSignal: AbortSignal.timeout(120_000),
      ...aiAnalytics.stepCallbacks,
      ...(aiAnalytics.onStreamError
        ? { onError: aiAnalytics.onStreamError }
        : {}),
    });

    // Assign stable IDs at push time so they don't change across persists
    const headings: AnalysisHeading[] = [];

    const persistPartial = async () => {
      // audit: skip — background AI analysis output
      const partial: AnalysisInProgress = {
        version: 1,
        generatedAt: new Date().toISOString(),
        model: modelId,
        tree: headings,
        status: "generating",
      };

      await rootDb
        .update(caseLawDecisions)
        .set({ analysis: partial })
        .where(eq(caseLawDecisions.id, decisionId));
    };

    for await (const raw of result.elementStream) {
      const heading = createAnalysisHeading({
        heading: raw,
        language: decision.language,
      });
      headings.push(heading);
      await persistPartial();
    }

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

export const generateAnalysis = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
  orgAIConfig: OrgAIConfig | null,
  promptCachingEnabled: boolean,
): Promise<{
  status: "done" | "error" | "generating";
  analysis?: PersistedDecisionAnalysis;
  error?: string;
}> => {
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
    return { status: "error", error: "Decision not found" };
  }

  const analysis = parsePersistedDecisionAnalysis(decision.analysis);

  // Return cached analysis (complete or partial with progress)
  if (isAnalysisInProgress(analysis)) {
    return { status: "generating", analysis };
  }

  if (isDecisionAnalysis(analysis)) {
    return { status: "done", analysis };
  }

  // Concurrent generation guard for the lightweight sentinel without a tree.
  if (isAnalysisGenerating(analysis)) {
    const startedAt = new Date(analysis.startedAt).getTime();
    if (Date.now() - startedAt < SENTINEL_STALE_MS) {
      return { status: "generating" };
    }
  }

  // Check AST
  if (!hasUsableAst(decision.documentAst)) {
    return { status: "error", error: "Decision has no parseable AST" };
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
    return { status: "generating" };
  }

  // Fire-and-forget generation
  void runGeneration(
    decisionId,
    ast,
    decision,
    organizationId,
    orgAIConfig,
    promptCachingEnabled,
  );

  return { status: "generating" };
};
