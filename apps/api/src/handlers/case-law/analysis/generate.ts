/**
 * Generate AI analysis for a court decision.
 *
 * Returns cached analysis if available. Otherwise kicks off
 * background generation and returns 202. The frontend polls
 * until the analysis is ready.
 */

import { valibotSchema } from "@ai-sdk/valibot";
import { Output, streamText } from "ai";
import { and, eq, isNull } from "drizzle-orm";

import type {
  AnalysisHeading,
  AnalysisInProgress,
  DecisionAnalysis,
  PersistedDecisionAnalysis,
} from "@stella/case-law/analysis";
import {
  analysisHeadingSchema,
  isAnalysisInProgress,
  isAnalysisGenerating,
  isDecisionAnalysis,
} from "@stella/case-law/analysis";
import type { DocumentAst } from "@stella/case-law/document-ast";
import { hasUsableAst } from "@stella/case-law/document-ast";

import type { ScopedDb } from "@/api/db";
// SAFETY: rootDb is used only inside runGeneration, which runs in
// a fire-and-forget background task after the request scope has
// ended. scopedDb is request-tied and would double-stringify the
// JSONB analysis payload in this context.
// eslint-disable-next-line no-restricted-imports
import { db as rootDb } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import { getModelForRole } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";

import { formatDecisionForPrompt } from "./prompts/base";
import { getSystemPrompt } from "./prompts/index";

const SENTINEL_STALE_MS = 5 * 60 * 1000;

/**
 * Run the AI generation in the background. Updates the DB
 * when done; clears the sentinel on failure.
 */
const runGeneration = async (
  decisionId: string,
  ast: DocumentAst,
  decision: {
    court: string;
    country: string;
    language: string;
    decisionType: string | null;
  },
) => {
  const systemPrompt = getSystemPrompt(decision.language);
  const decisionText = formatDecisionForPrompt(ast.blocks);

  const userMessage = `Court: ${decision.court}
Country: ${decision.country}
Type: ${decision.decisionType ?? "unknown"}

${decisionText}`;

  const model = getModelForRole("fast");
  const modelId =
    typeof model === "string"
      ? model
      : "modelId" in model
        ? model.modelId
        : "unknown";
  const aiAnalytics = createAIAnalyticsCallbacks({
    feature: "case-law.analysis",
    properties: {
      decision_id: decisionId,
    },
    sessionId: decisionId,
    traceId: crypto.randomUUID(),
  });

  try {
    const result = streamText({
      model,
      output: Output.array({
        element: valibotSchema(analysisHeadingSchema),
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
      headings.push({
        ...raw,
        id: crypto.randomUUID(),
        annotations: raw.annotations.map((a) => ({
          ...a,
          id: crypto.randomUUID(),
        })),
        children: [],
      });
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

    // Use rootDb directly (not scopedDb) because:
    // 1. Case law analysis is global, not workspace-scoped
    // 2. The scopedDb from the request context may double-stringify
    //    JSONB values when used in a fire-and-forget background task
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
  decisionId: string,
  scopedDb: ScopedDb,
): Promise<{
  status: "done" | "error" | "generating";
  analysis?: PersistedDecisionAnalysis;
  error?: string;
}> => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: decisionId },
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

  // Return cached analysis (complete or partial with progress)
  if (isAnalysisInProgress(decision.analysis)) {
    return { status: "generating", analysis: decision.analysis };
  }

  if (isDecisionAnalysis(decision.analysis)) {
    return { status: "done", analysis: decision.analysis };
  }

  // Concurrent generation guard (old sentinel format without tree)
  if (isAnalysisGenerating(decision.analysis)) {
    const startedAt = new Date(decision.analysis.startedAt).getTime();
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
  void runGeneration(decisionId, ast, decision);

  return { status: "generating" };
};
