import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type {
  CaseLawResearchAnswerRun,
  CaseLawResearchAnswerValue,
} from "@stll/api-contract";
import { parseUsableDocumentAst } from "@stll/legal-ast/document-ast";

import type { SafeDb } from "@/api/db/safe-db";
import { caseLawResearchAnswers } from "@/api/db/schema";
import { resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  buildResearchUserMessage,
  parseResearchAnswers,
  RESEARCH_SYSTEM_PROMPT,
  researchAnswersOutputSchema,
  selectPassagesWithinBudget,
} from "@/api/lib/case-law/research-answers";
import type {
  ResearchAnswerFailureReason,
  ResearchPassage,
  ResearchQuestion,
} from "@/api/lib/case-law/research-answers";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusFreeTextClause,
  quoteCorpusValue,
} from "@/api/lib/legal-search/corpus-query";
import {
  allowsDerivedAi,
  isRedistributable,
} from "@/api/lib/legal-search/corpus-source";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import {
  parsePersistedCorpusAst,
  readCorpusAst,
  readCorpusPayloadOrFallback,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import { corpusIndexRoute } from "@/api/lib/legal-search/index-naming";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { getTanStackTextModelForRole } from "@/api/lib/tanstack-ai-models";

const ANSWER_TIMEOUT_MS = 120_000;

export type ResearchRunColumn = ResearchQuestion & {
  columnId: SafeId<"caseLawResearchColumn">;
};

export type RunResearchAnswersInput = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  columns: readonly ResearchRunColumn[];
  decisionIds: readonly SafeId<"caseLawDecision">[];
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
};

export type RunResearchAnswersDeps = {
  /** Tenant-scoped, Result-wrapped handle the answers are written through. */
  safeDb: SafeDb;
  /** The public corpus gate the decision text is read through. */
  caseLawDb: CaseLawPublicReadDb;
};

/**
 * Answer every pending cell of the given columns for the given decisions, a
 * bounded number of decisions at a time. Each decision's text is read once and
 * all of its pending questions go to the model in one call. Runs detached
 * from the request that queued it; every failure lands in the cell's state.
 */
export const runResearchAnswers = async (
  input: RunResearchAnswersInput,
  deps: RunResearchAnswersDeps,
): Promise<void> => {
  const queue = [...input.decisionIds];
  const worker = async (): Promise<void> => {
    for (;;) {
      const decisionId = queue.shift();
      if (decisionId === undefined) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- one worker of a bounded pool drains its share sequentially
      await answerDecision(decisionId, input, deps).catch((error: unknown) => {
        captureError(error, {
          source: "case-law-research-answers",
          decisionId,
        });
      });
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(LIMITS.caseLawResearchRunConcurrency, queue.length) },
      worker,
    ),
  );
};

type DecisionTextSource =
  | { kind: "passages"; passages: ResearchPassage[]; retrieved: boolean }
  | { kind: "none" };

type ResearchDecisionRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  court: string;
  country: string;
  language: string;
  decisionType: string | null;
  documentAst: unknown;
  astS3Key: string | null;
  textS3Key: string | null;
  contentHash: string | null;
  fulltext: string | null;
  source: { descriptor: CorpusSourceDescriptor | null } | null;
};

const answerDecision = async (
  decisionId: SafeId<"caseLawDecision">,
  input: RunResearchAnswersInput,
  { caseLawDb, safeDb }: RunResearchAnswersDeps,
): Promise<void> => {
  const pendingColumnIds = await pendingColumnsFor(decisionId, input, safeDb);
  if (pendingColumnIds.length === 0) {
    return;
  }
  const questions = input.columns.filter((column) =>
    pendingColumnIds.includes(column.columnId),
  );
  const fail = async (failureReason: ResearchAnswerFailureReason) =>
    await writeOutcomes(
      safeDb,
      input.organizationId,
      decisionId,
      questions.map((question) => ({
        columnId: question.columnId,
        outcome: { state: "failed", failureReason },
      })),
    );

  const decision = await caseLawDb(
    async (tx) => await readResearchDecision(tx, decisionId),
  );
  if (
    decision === null ||
    decision.source === null ||
    !isRedistributable(decision.source.descriptor)
  ) {
    await fail("decision_unavailable");
    return;
  }
  // Sources carry different reuse terms. One whose terms withhold derived AI
  // use is read and listed, but its text is never sent to a model.
  if (!allowsDerivedAi(decision.source.descriptor)) {
    await writeOutcomes(
      safeDb,
      input.organizationId,
      decisionId,
      questions.map((question) => ({
        columnId: question.columnId,
        outcome: { state: "not_allowed" },
      })),
    );
    return;
  }

  const text = await resolveDecisionText(decision, questions, caseLawDb);
  if (text.kind === "none") {
    await fail("no_text");
    return;
  }

  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "case-law.research-answers",
    modelRole: "fast",
    organizationId: input.organizationId,
    orgAIConfig: input.orgAIConfig,
    properties: {
      decision_id: decisionId,
      jurisdiction: decision.country,
      organization_id: input.organizationId,
      question_count: questions.length,
    },
    sessionId: decisionId,
    traceId: Bun.randomUUIDv7(),
    usageMetering: {
      actionType: "case_law",
      organizationId: input.organizationId,
      safeDb,
      serviceTier: "standard",
      userId: input.userId,
      workspaceId: null,
    },
  });

  const generated = await Result.tryPromise({
    try: async () => {
      const { modelId } = getTanStackTextModelForRole(
        "fast",
        input.orgAIConfig,
        { organizationId: input.organizationId },
      );
      const output = await generateTanStackObjectForRole({
        role: "fast",
        serviceTier: "standard",
        orgAIConfig: input.orgAIConfig,
        organizationId: input.organizationId,
        // The corpus is global; answers are tenant rows written separately.
        tenantWorkspaceIds: [],
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled: input.promptCachingEnabled,
          role: "fast",
          scopeKey: decisionId,
        }),
        system: RESEARCH_SYSTEM_PROMPT,
        prompt: buildResearchUserMessage({
          decision,
          passages: text.passages,
          questions,
          retrieved: text.retrieved,
        }),
        outputSchema: researchAnswersOutputSchema,
        abortSignal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
      });
      return { modelId, output };
    },
    catch: (error) => error,
  });
  if (Result.isError(generated)) {
    aiAnalytics.captureError(generated.error);
    await fail("model_error");
    return;
  }

  const knownAnchorIds = new Set(
    text.passages.map((passage) => passage.anchorId),
  );
  const excerptByAnchor = new Map(
    text.passages.map((passage) => [passage.anchorId, passage.excerpt]),
  );
  const parsed = parseResearchAnswers({
    output: generated.value.output,
    questions,
    knownAnchorIds,
  });
  const completedAt = new Date().toISOString();
  await writeOutcomes(
    safeDb,
    input.organizationId,
    decisionId,
    parsed.map((entry) => {
      if (entry.outcome.state === "failed") {
        return entry;
      }
      const run: CaseLawResearchAnswerRun = {
        version: 1,
        model: generated.value.modelId,
        completedAt,
        retrieved: text.retrieved,
        rationale: entry.outcome.rationale,
        passages: entry.outcome.anchorIds.map((anchorId) => ({
          anchorId,
          excerpt: (excerptByAnchor.get(anchorId) ?? "").slice(0, 300),
        })),
      };
      return {
        columnId: entry.columnId,
        outcome: {
          state: "answered",
          answer: entry.outcome.answer,
          confidence: entry.outcome.confidence,
          run,
        },
      };
    }),
  );
};

const pendingColumnsFor = async (
  decisionId: SafeId<"caseLawDecision">,
  input: RunResearchAnswersInput,
  safeDb: SafeDb,
): Promise<SafeId<"caseLawResearchColumn">[]> => {
  const columnIds = input.columns.map((column) => column.columnId);
  if (columnIds.length === 0) {
    return [];
  }
  const rows = await safeDb(
    async (tx) =>
      await tx
        .select({ columnId: caseLawResearchAnswers.columnId })
        .from(caseLawResearchAnswers)
        .where(
          and(
            inArray(caseLawResearchAnswers.columnId, columnIds),
            eq(caseLawResearchAnswers.decisionId, decisionId),
            eq(caseLawResearchAnswers.organizationId, input.organizationId),
            eq(caseLawResearchAnswers.state, "pending"),
          ),
        ),
  );
  if (Result.isError(rows)) {
    throw rows.error;
  }
  return rows.value.map((row) => row.columnId);
};

const readResearchDecision = async (
  tx: CaseLawPublicReadTransaction,
  decisionId: SafeId<"caseLawDecision">,
): Promise<ResearchDecisionRow | null> => {
  const row = await tx.query.caseLawDecisions.findFirst({
    where: { id: { eq: decisionId } },
    columns: {
      id: true,
      caseNumber: true,
      court: true,
      country: true,
      language: true,
      decisionType: true,
      documentAst: true,
      astS3Key: true,
      textS3Key: true,
      contentHash: true,
      fulltext: true,
    },
    // `descriptor` decides redistribution and derived-AI use; never returned.
    with: { source: { columns: { descriptor: true } } },
  });
  return row ?? null;
};

/**
 * The decision as anchored passages: the AST's blocks when it has one (each
 * block's anchor is what the reader scrolls to), otherwise the stored text as
 * one unanchored passage. Over budget, the passages most relevant to the
 * questions are retrieved from the corpus index instead.
 */
const resolveDecisionText = async (
  decision: ResearchDecisionRow,
  questions: readonly ResearchQuestion[],
  caseLawDb: CaseLawPublicReadDb,
): Promise<DecisionTextSource> => {
  const blocks = await readDecisionBlocks(decision);
  const passages: ResearchPassage[] =
    blocks === null
      ? await readDecisionFulltextPassage(decision)
      : blocks.flatMap((block) =>
          block.plainText.trim().length > 0
            ? [{ anchorId: block.anchorId, excerpt: block.plainText.trim() }]
            : [],
        );
  if (passages.length === 0) {
    return { kind: "none" };
  }
  const total = passages.reduce(
    (sum, passage) => sum + passage.excerpt.length,
    0,
  );
  if (total <= LIMITS.caseLawResearchAnswerTextBudgetChars) {
    return { kind: "passages", passages, retrieved: false };
  }

  const retrieved = await retrievePassages(decision, questions, caseLawDb);
  const selected = selectPassagesWithinBudget(
    retrieved.length > 0 ? retrieved : passages,
    {
      budgetChars: LIMITS.caseLawResearchAnswerTextBudgetChars,
      passageChars: LIMITS.caseLawResearchAnswerPassageChars,
    },
  );
  return selected.length === 0
    ? { kind: "none" }
    : { kind: "passages", passages: selected, retrieved: true };
};

/** A row's corpus object, or its Postgres copy when the object is unreadable. */
const readStoredPayload = async <T>({
  decision,
  fallback,
  key,
  read,
  step,
}: {
  decision: ResearchDecisionRow;
  key: string | null;
  step: string;
  read: (key: string) => Promise<T>;
  fallback: () => T | null;
}): Promise<T | null> => {
  if (key === null || decision.contentHash === null) {
    return fallback();
  }
  const stored = await Result.tryPromise(
    async () =>
      await readCorpusPayloadOrFallback({
        documentId: decision.id,
        key,
        step,
        read: async () => await read(key),
        fallback: async () => await Promise.resolve(fallback()),
      }),
  );
  return Result.isOk(stored) ? stored.value : null;
};

const readDecisionBlocks = async (
  decision: ResearchDecisionRow,
): Promise<{ anchorId: string; plainText: string; type: string }[] | null> => {
  const stored = await readStoredPayload({
    decision,
    key: decision.astS3Key,
    step: "researchAnswers.corpusAst",
    read: readCorpusAst,
    fallback: () => parsePersistedCorpusAst(decision.documentAst),
  });
  const ast = stored === null ? null : parseUsableDocumentAst(stored);
  return ast === null ? null : ast.blocks;
};

const readDecisionFulltextPassage = async (
  decision: ResearchDecisionRow,
): Promise<ResearchPassage[]> => {
  const text = await readStoredPayload({
    decision,
    key: decision.textS3Key,
    step: "researchAnswers.corpusText",
    read: readCorpusText,
    fallback: () => decision.fulltext,
  });
  const trimmed = text?.trim() ?? "";
  return trimmed.length === 0 ? [] : [{ anchorId: "text", excerpt: trimmed }];
};

/** The passages of one decision that match the questions, best first. */
const retrievePassages = async (
  decision: ResearchDecisionRow,
  questions: readonly ResearchQuestion[],
  caseLawDb: CaseLawPublicReadDb,
): Promise<ResearchPassage[]> => {
  const freeText = corpusFreeTextClause(
    questions.map((question) => question.question).join(" "),
  );
  if (freeText === null) {
    return [];
  }
  const searched = await Result.tryPromise(async () => {
    const serving = await caseLawDb(
      async (tx) => await readServingCorpusIndexGenerationTx(tx, "case_law"),
    );
    const { indexId } = corpusIndexRoute(serving.generation, decision.country);
    return await getCorpusIndexClient(serving.cluster).search({
      indexId,
      query: `document_id:${quoteCorpusValue(decision.id)} AND ${freeText}`,
      maxHits: LIMITS.caseLawResearchAnswerPassagesMax,
      sortBy: "_score",
    });
  });
  if (Result.isError(searched) || Result.isError(searched.value)) {
    return [];
  }
  return searched.value.value.hits.flatMap((hit) => {
    const anchorId = hit["anchor_id"];
    const text = hit["text"];
    return typeof anchorId === "string" &&
      anchorId.length > 0 &&
      typeof text === "string"
      ? [{ anchorId, excerpt: text }]
      : [];
  });
};

type AnswerOutcome =
  | {
      state: "answered";
      answer: CaseLawResearchAnswerValue;
      confidence: number;
      run: CaseLawResearchAnswerRun;
    }
  | { state: "not_allowed" }
  | { state: "failed"; failureReason: ResearchAnswerFailureReason };

type ColumnOutcome = { columnId: string; outcome: AnswerOutcome };

/** Persist one decision's outcomes; only cells still pending are touched. */
const writeOutcomes = async (
  safeDb: SafeDb,
  organizationId: SafeId<"organization">,
  decisionId: SafeId<"caseLawDecision">,
  outcomes: readonly ColumnOutcome[],
): Promise<void> => {
  const now = new Date();
  const written = await safeDb(async (tx) => {
    for (const { columnId, outcome } of outcomes) {
      const values =
        outcome.state === "answered"
          ? {
              state: outcome.state,
              answer: outcome.answer,
              confidence: outcome.confidence,
              run: outcome.run,
              failureReason: null,
            }
          : {
              state: outcome.state,
              answer: null,
              confidence: null,
              run: null,
              failureReason:
                outcome.state === "failed" ? outcome.failureReason : null,
            };
      // SAFETY: bounded by LIMITS.caseLawResearchColumnsPerTable, inside one
      // transaction; each cell is its own row so a batch would be a VALUES join
      // of the same size.
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- bounded by the column cap
      await tx
        .update(caseLawResearchAnswers)
        .set({ ...values, updatedAt: now })
        .where(
          and(
            eq(caseLawResearchAnswers.columnId, columnId),
            eq(caseLawResearchAnswers.decisionId, decisionId),
            eq(caseLawResearchAnswers.organizationId, organizationId),
            eq(caseLawResearchAnswers.state, "pending"),
          ),
        );
    }
  });
  if (Result.isError(written)) {
    throw written.error;
  }
};
