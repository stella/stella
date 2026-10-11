import { panic, Result, TaggedError } from "better-result";
import { and, eq, exists, inArray, sql } from "drizzle-orm";

import type { CaseLawResearchAnswerFailureReason } from "@stll/api-contract";
import { declareFailureClass } from "@stll/errors";
import type { FailureReason } from "@stll/errors";
import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawResearchAnswers,
  caseLawResearchColumns,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { resolveCaching } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { reportCaseLawIncompleteAnswer } from "@/api/lib/case-law/incomplete-answer-telemetry";
import type {
  ResearchAnswerClaim,
  ResearchAnswerCell,
} from "@/api/lib/case-law/research-answer-queue";
import {
  buildAnswerJustification,
  buildResearchAnswersSchema,
  buildResearchUserMessage,
  parseResearchAnswers,
  RESEARCH_SYSTEM_PROMPT,
  selectPassagesWithinBudget,
} from "@/api/lib/case-law/research-answers";
import type {
  CaseLawResearchAnswerRun,
  ResearchPassage,
  ResearchQuestion,
} from "@/api/lib/case-law/research-answers";
import {
  exceedsSystemOneSourceBudget,
  resolveSystemOneOutcomes,
  splitSystemOneQuestions,
  systemOneSourcesFromPassages,
} from "@/api/lib/case-law/research-answers-system-one";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import {
  caseLawCorpusAppliedRevision,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CorpusIndexGroupNotReadyError,
  readServingCorpusIndexTargetTx,
} from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import { corpusIndexRoute } from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusRevisionClause } from "@/api/lib/legal-search/corpus-index-revision-clause";
import {
  corpusFreeTextClause,
  quoteCorpusValue,
} from "@/api/lib/legal-search/corpus-query";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-reads";
import {
  allowsDerivedAi,
  isRedistributable,
} from "@/api/lib/legal-search/corpus-source";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import {
  parsePersistedCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { getTanStackTextModelInfoForRole } from "@/api/lib/tanstack-ai-models";
import {
  decodeSystemOneAnswers,
  planSystemOneAnswers,
} from "@/api/lib/workflow/decisions/answer-questions";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";

const ANSWER_TIMEOUT_MS = 120_000;

const RESEARCH_PASSAGE_RETRIEVAL_FAILED_SINK = failureSink({
  event: "case_law.research_passage_retrieval_failed",
  expected: [],
});

const RESEARCH_PASSAGE_RETRIEVAL_REASON = {
  INDEX_NOT_READY: "index-not-ready",
  TARGET_UNAVAILABLE: "target-unavailable",
  SEARCH_FAILED: "search-failed",
} as const;

type ResearchPassageRetrievalReason =
  (typeof RESEARCH_PASSAGE_RETRIEVAL_REASON)[keyof typeof RESEARCH_PASSAGE_RETRIEVAL_REASON];

const RESEARCH_PASSAGE_FAILURE_REASON = {
  "index-not-ready": "research_index_not_ready",
  "target-unavailable": "research_passage_target_failed",
  "search-failed": "research_passage_search_failed",
} as const satisfies Record<ResearchPassageRetrievalReason, FailureReason>;

export class ResearchPassageRetrievalError extends TaggedError(
  "ResearchPassageRetrievalError",
)<{
  message: string;
  reason: ResearchPassageRetrievalReason;
  cause: unknown;
}> {
  static {
    declareFailureClass(
      this,
      ({ reason }) => RESEARCH_PASSAGE_FAILURE_REASON[reason],
    );
  }
}

export type ResearchRunColumn = ResearchQuestion & {
  columnId: SafeId<"caseLawResearchColumn">;
};

export type RunResearchAnswersInput = {
  /** The queuing request's admission: the whole run is one action. */
  admission: ModelDispatchAdmission;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  columns: readonly ResearchRunColumn[];
  /**
   * The cells this run claimed, and the id stamped on each of them. The run
   * works this set alone, never the whole column-by-decision rectangle: a cell
   * another run is working on was not claimed here and is not touched.
   */
  claim: ResearchAnswerClaim;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
};

export type RunResearchAnswersDeps = {
  /** Tenant-scoped, Result-wrapped handle the answers are written through. */
  safeDb: SafeDb;
  /** The public corpus gate the decision text is read through. */
  caseLawDb: CaseLawPublicReadDb;
  /**
   * The client the typed-judgment tier asks. Undefined is the org's own
   * resolved decision model (null when the deployment has none, which leaves
   * every column to the generative model); a test pins one.
   */
  decisionModel?: DecisionModel | null | undefined;
};

/** The claimed cells regrouped into the unit of work: one decision's questions. */
const claimedColumnsByDecision = (
  cells: readonly ResearchAnswerCell[],
): Map<SafeId<"caseLawDecision">, SafeId<"caseLawResearchColumn">[]> => {
  const byDecision = new Map<
    SafeId<"caseLawDecision">,
    SafeId<"caseLawResearchColumn">[]
  >();
  for (const { columnId, decisionId } of cells) {
    const columnIds = byDecision.get(decisionId);
    if (columnIds === undefined) {
      byDecision.set(decisionId, [columnId]);
      continue;
    }
    columnIds.push(columnId);
  }
  return byDecision;
};

/**
 * Answer the cells this run claimed, a bounded number of decisions at a time.
 * Each decision's text is read once and all of its claimed questions go to the
 * model in one call. Runs detached from the request that queued it; every
 * failure lands in the cell's state.
 */
export const runResearchAnswers = async (
  input: RunResearchAnswersInput,
  deps: RunResearchAnswersDeps,
): Promise<void> => {
  const byDecision = claimedColumnsByDecision(input.claim.cells);
  const queue = [...byDecision.entries()];
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) {
        return;
      }
      const [decisionId, claimedColumnIds] = next;
      const failure = await answerDecision(
        decisionId,
        claimedColumnIds,
        input,
        deps,
      ).then(
        () => null,
        (error: unknown) => error ?? new Error("research answer run failed"),
      );
      if (failure === null) {
        continue;
      }
      captureError(failure, {
        source: "case-law-research-answers",
        decisionId,
      });
      // Whatever this run still held for this decision is not coming: say so
      // rather than leave the cells to age out. Only the claimed columns, so a
      // cell that belongs to another run is untouched.
      await writeOutcomes(
        deps.safeDb,
        input,
        decisionId,
        claimedColumnIds.map((columnId) => ({
          columnId,
          outcome: { state: "failed", failureReason: "run_error" },
        })),
      ).catch((writeError: unknown) => {
        captureError(writeError, {
          source: "case-law-research-answers-cleanup",
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
  | {
      kind: "passages";
      passages: ResearchPassage[];
      retrieved: boolean;
      // Set when retrieval was attempted and failed; it is already reported,
      // so later stages fall back instead of retrying it.
      retrievalFailed: boolean;
    }
  | { kind: "none" };

type SelectDecisionPassagesOptions = {
  fallback: readonly ResearchPassage[];
  retrieved: readonly ResearchPassage[];
  retrievalFailed: boolean;
  budgetChars: number;
};

/** Keep retrieval provenance false when the index returned no usable passage. */
export const selectDecisionPassages = ({
  fallback,
  retrieved,
  retrievalFailed,
  budgetChars,
}: SelectDecisionPassagesOptions): DecisionTextSource => {
  const selected = selectPassagesWithinBudget(
    retrieved.length > 0 ? retrieved : fallback,
    {
      budgetChars,
      passageChars: LIMITS.caseLawResearchAnswerPassageChars,
    },
  );
  return selected.length === 0
    ? { kind: "none" }
    : {
        kind: "passages",
        passages: selected,
        retrieved: retrieved.length > 0,
        retrievalFailed,
      };
};

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
  claimedColumnIds: readonly SafeId<"caseLawResearchColumn">[],
  input: RunResearchAnswersInput,
  { caseLawDb, safeDb, decisionModel }: RunResearchAnswersDeps,
): Promise<void> => {
  const pendingColumnIds = await stillClaimedColumnsFor(
    decisionId,
    claimedColumnIds,
    input,
    safeDb,
  );
  if (pendingColumnIds.length === 0) {
    return;
  }
  const questions = input.columns.filter((column) =>
    pendingColumnIds.includes(column.columnId),
  );
  const fail = async (failureReason: CaseLawResearchAnswerFailureReason) =>
    await writeOutcomes(
      safeDb,
      input,
      decisionId,
      questions.map((question) => ({
        columnId: question.columnId,
        outcome: { state: "failed", failureReason },
      })),
    );

  const decision = await caseLawDb(
    async (tx) => await readResearchDecision(tx, decisionId),
  );
  if (decision === null) {
    await fail("decision_unavailable");
    return;
  }
  const { source } = decision;
  if (source === null || !isRedistributable(source.descriptor)) {
    await fail("decision_unavailable");
    return;
  }
  // Sources carry different reuse terms. One whose terms withhold derived AI
  // use is read and listed, but its text is never sent to a model.
  if (!allowsDerivedAi(source.descriptor)) {
    await writeOutcomes(
      safeDb,
      input,
      decisionId,
      questions.map((question) => ({
        columnId: question.columnId,
        outcome: { state: "not_allowed" },
      })),
    );
    return;
  }

  const text = await resolveDecisionText(
    decision,
    questions,
    caseLawDb,
    LIMITS.caseLawResearchAnswerTextBudgetChars,
  );
  if (text.kind === "none") {
    await fail("no_text");
    return;
  }

  // Always asked: without a decision model every question comes back
  // undecided and every column falls through to the generative call.
  const tier = await answerWithSystemOne({
    caseLawDb,
    decisionModel,
    orgAIConfig: input.orgAIConfig,
    decision,
    questions,
    text,
    usageMetering: {
      actionType: "case_law",
      organizationId: input.organizationId,
      safeDb,
      serviceTier: "standard",
      userId: input.userId,
      workspaceId: null,
    },
  });
  const settled = tier.outcomes;
  const generativeQuestions = tier.remaining;
  if (generativeQuestions.length === 0) {
    await writeOutcomes(safeDb, input, decisionId, settled);
    return;
  }

  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    feature: "case-law.research-answers",
    modelRole: "fast",
    organizationId: input.organizationId,
    orgAIConfig: input.orgAIConfig,
    properties: {
      decision_id: decisionId,
      jurisdiction: decision.country,
      organization_id: input.organizationId,
      question_count: generativeQuestions.length,
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
      const { modelId } = getTanStackTextModelInfoForRole(
        "fast",
        input.orgAIConfig,
        {
          dataClass: "customer",
          organizationId: input.organizationId,
        },
      );
      const output = await generateTanStackObjectForRole({
        dataClass: "customer",
        role: "fast",
        serviceTier: "standard",
        orgAIConfig: input.orgAIConfig,
        managedAIResidency: input.managedAIResidency,
        organizationId: input.organizationId,
        admission: input.admission,
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
          questions: generativeQuestions,
          retrieved: text.retrieved,
        }),
        outputSchema: buildResearchAnswersSchema(generativeQuestions),
        abortSignal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
      });
      return { modelId, output };
    },
    catch: (error) => error,
  });
  if (Result.isError(generated)) {
    aiAnalytics.captureError(generated.error);
    // Only what the generative model was asked failed; a cell the typed tier
    // already settled keeps its answer.
    await writeOutcomes(safeDb, input, decisionId, [
      ...settled,
      ...generativeQuestions.map((question): ColumnOutcome => ({
        columnId: question.columnId,
        outcome: { state: "failed", failureReason: "model_error" },
      })),
    ]);
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
    questions: generativeQuestions,
    knownAnchorIds,
  });
  // The parser speaks in plain column ids; the branded ids come back from the
  // questions we asked, so an id the model invented can never reach a write.
  const brandedColumnIds = new Map<string, SafeId<"caseLawResearchColumn">>(
    questions.map((question) => [question.columnId, question.columnId]),
  );
  const completedAt = Temporal.Now.instant().toString({
    fractionalSecondDigits: 3,
  });
  const outcomes: ColumnOutcome[] = [...settled];
  for (const entry of parsed) {
    const columnId = brandedColumnIds.get(entry.columnId);
    if (columnId === undefined) {
      continue;
    }
    const parsedOutcome = entry.outcome;
    if (parsedOutcome.state === "failed") {
      outcomes.push({
        columnId,
        outcome: {
          state: "failed",
          failureReason: parsedOutcome.failureReason,
        },
      });
      continue;
    }
    const run: CaseLawResearchAnswerRun = {
      version: 1,
      model: generated.value.modelId,
      completedAt,
      retrieved: text.retrieved,
      rationale: parsedOutcome.rationale,
      justification: buildAnswerJustification(
        parsedOutcome.anchorIds,
        excerptByAnchor,
      ),
    };
    outcomes.push({
      columnId,
      outcome:
        parsedOutcome.state === "answered"
          ? { state: "answered", answer: parsedOutcome.answer, run }
          : { state: "not_stated", run },
    });
  }
  await writeOutcomes(safeDb, input, decisionId, outcomes);
};

/**
 * The claimed cells this run still owns: pending, and still stamped with this
 * run's claim id. A cell re-queued by a newer run carries that run's id and is
 * left to it, so a run that stalled and woke up answers nothing.
 */
const stillClaimedColumnsFor = async (
  decisionId: SafeId<"caseLawDecision">,
  claimedColumnIds: readonly SafeId<"caseLawResearchColumn">[],
  input: RunResearchAnswersInput,
  safeDb: SafeDb,
): Promise<SafeId<"caseLawResearchColumn">[]> => {
  if (claimedColumnIds.length === 0) {
    return [];
  }
  const rows = await safeDb(
    async (tx) =>
      await tx
        .select({ columnId: caseLawResearchAnswers.columnId })
        .from(caseLawResearchAnswers)
        .where(
          and(
            inArray(caseLawResearchAnswers.columnId, [...claimedColumnIds]),
            eq(caseLawResearchAnswers.decisionId, decisionId),
            eq(caseLawResearchAnswers.organizationId, input.organizationId),
            eq(caseLawResearchAnswers.state, "pending"),
            eq(caseLawResearchAnswers.claimId, input.claim.claimId),
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
  budgetChars: number,
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
  if (total <= budgetChars) {
    return {
      kind: "passages",
      passages,
      retrieved: false,
      retrievalFailed: false,
    };
  }

  const retrieved = await retrieveResearchPassages({
    decision,
    questions,
    caseLawDb,
  });
  return selectDecisionPassages({
    fallback: passages,
    retrieved: retrieved.unwrapOr([]),
    retrievalFailed: retrieved.isErr(),
    budgetChars,
  });
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
  const ast = stored === null ? null : parseCaseLawDecisionAst(stored);
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

type RetrieveResearchPassagesOptions = {
  decision: Pick<ResearchDecisionRow, "id" | "country">;
  questions: readonly { question: string }[];
  caseLawDb: CaseLawPublicReadDb;
  clientForCluster?: typeof getCorpusIndexClient;
};

type CurrentResearchRevisionOptions = {
  decisionId: SafeId<"caseLawDecision">;
  generation: string;
};

/**
 * The revision the serving generation records as applied for the decision,
 * or null when it holds no current copy (pending, queued for erasure, or
 * never projected). Passages are read from that revision's copy only.
 */
const readCurrentResearchRevisionTx = async (
  tx: CaseLawPublicReadTransaction,
  { decisionId, generation }: CurrentResearchRevisionOptions,
) => {
  const [row] = await tx
    .select({
      appliedRevision: caseLawCorpusAppliedRevision(generation),
    })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.id, decisionId),
        currentCaseLawCorpusProjection(generation),
      ),
    )
    .limit(1);
  return row?.appliedRevision ?? null;
};

/** The passages of one decision that match the questions, best first. */
export const retrieveResearchPassages = async ({
  decision,
  questions,
  caseLawDb,
  clientForCluster = getCorpusIndexClient,
}: RetrieveResearchPassagesOptions) => {
  const freeText = corpusFreeTextClause(
    questions.map((question) => question.question).join(" "),
  );
  if (freeText === null) {
    return Result.ok([]);
  }
  const searched = await Result.gen(async function* () {
    const target = yield* (
      await Result.tryPromise(
        async () =>
          await caseLawDb(async (tx) => {
            const serving = await readServingCorpusIndexTargetTx(tx, {
              family: "case_law",
              jurisdiction: decision.country,
            });
            if (serving.isErr()) {
              return Result.err(serving.error);
            }
            return Result.ok({
              ...serving.value,
              appliedRevision: await readCurrentResearchRevisionTx(tx, {
                decisionId: decision.id,
                generation: serving.value.serving.generation,
              }),
            });
          }),
      )
    )
      .andThen((result) => result)
      .mapError(
        (cause) =>
          new ResearchPassageRetrievalError({
            message:
              "Research passage retrieval could not read its serving target",
            reason: CorpusIndexGroupNotReadyError.is(cause)
              ? RESEARCH_PASSAGE_RETRIEVAL_REASON.INDEX_NOT_READY
              : RESEARCH_PASSAGE_RETRIEVAL_REASON.TARGET_UNAVAILABLE,
            cause,
          }),
      );
    const { serving, manifest, appliedRevision } = target;
    if (appliedRevision === null) {
      return Result.ok([]);
    }
    const { indexId } = corpusIndexRoute(manifest, decision.country);
    const decisionClause = corpusRevisionClause({
      clause: `document_id:${quoteCorpusValue(decision.id)}`,
      field: manifest.projection.projectionRevisionField,
      revision: appliedRevision,
    });
    const response = yield* (
      await Result.tryPromise(
        async () =>
          await clientForCluster(serving.cluster).search({
            observer: "unobserved",
            indexId,
            query: `${decisionClause} AND ${freeText}`,
            maxHits: LIMITS.caseLawResearchAnswerPassagesMax,
            sortBy: "_score",
          }),
      )
    )
      .andThen((result) => result)
      .mapError(
        (cause) =>
          new ResearchPassageRetrievalError({
            message:
              "Research passage retrieval could not search its serving index",
            reason: RESEARCH_PASSAGE_RETRIEVAL_REASON.SEARCH_FAILED,
            cause,
          }),
      );
    const passages = response.hits.flatMap((hit) => {
      const anchorId = hit["anchor_id"];
      const text = hit["text"];
      return typeof anchorId === "string" &&
        anchorId.length > 0 &&
        typeof text === "string"
        ? [{ anchorId, excerpt: text }]
        : [];
    });
    reportCaseLawIncompleteAnswer({
      surface: "research",
      reason: "retrieved_passage_invalid",
      count: response.hits.length - passages.length,
    });
    return Result.ok(passages);
  });
  if (searched.isErr()) {
    observeFailure(searched.error, {
      sink: RESEARCH_PASSAGE_RETRIEVAL_FAILED_SINK,
      ctx: {
        decisionId: decision.id,
        jurisdiction: decision.country,
        stage: searched.error.reason,
      },
    });
  }
  return searched;
};

type SystemOnePassOptions = {
  caseLawDb: CaseLawPublicReadDb;
  decisionModel: DecisionModel | null | undefined;
  usageMetering: AIUsageMetering;
  orgAIConfig: OrgAIConfig | null;
  decision: ResearchDecisionRow;
  questions: readonly ResearchRunColumn[];
  text: {
    passages: readonly ResearchPassage[];
    retrieved: boolean;
    retrievalFailed: boolean;
  };
};

type SystemOnePass = {
  /** The cells the tier settled, ready to write. */
  outcomes: ColumnOutcome[];
  /** The questions the generative model still has to answer. */
  remaining: ResearchRunColumn[];
};

/**
 * Ask one decision's closed-answer questions in a single request and keep what
 * came back settled. Nothing here fails a cell: a transport error, an
 * unplannable question or an undecided answer leaves the column to the
 * generative call, which is the behaviour of a deployment without the tier.
 */
const answerWithSystemOne = async ({
  usageMetering,
  caseLawDb,
  decisionModel,
  orgAIConfig,
  decision,
  questions,
  text,
}: SystemOnePassOptions): Promise<SystemOnePass> => {
  const untouched: SystemOnePass = { outcomes: [], remaining: [...questions] };
  const { asked } = splitSystemOneQuestions(questions);
  if (asked.length === 0) {
    return untouched;
  }
  // The tier reads a smaller state than the generative prompt. Over that
  // budget the passages ranked against the questions are what it is worth
  // spending on; reading order would spend all of it on the decision's
  // opening. Text already resolved by retrieval is ranked, so it is only cut.
  const overBudget = exceedsSystemOneSourceBudget(text.passages);
  const ranked =
    overBudget && !text.retrieved && !text.retrievalFailed
      ? (
          await retrieveResearchPassages({
            decision,
            questions: asked,
            caseLawDb,
          })
        ).unwrapOr([])
      : [];
  const sources = systemOneSourcesFromPassages(
    ranked.length > 0 ? ranked : text.passages,
  );
  if (sources.length === 0) {
    return untouched;
  }
  const plan = planSystemOneAnswers({
    document: {
      caseNumber: decision.caseNumber,
      court: decision.court,
      country: decision.country,
      decisionType: decision.decisionType ?? "unknown",
      language: decision.language,
    },
    sources,
    language: decision.language,
    questions: asked,
  });
  if (plan.plans.size === 0) {
    return untouched;
  }
  const { decisions, model } = await decideMany({
    dataClass: "customer",
    id: "case-law.research-answers",
    orgAIConfig,
    state: plan.state,
    questions: plan.questions,
    timeoutMs: ANSWER_TIMEOUT_MS,
    client: decisionModel,
    usageMetering: { ...usageMetering, callId: Bun.randomUUIDv7() },
  });
  // No model answered, so nothing is settled and the run facts have no model
  // to stamp: every column is the generative model's.
  if (model === null) {
    return untouched;
  }
  const resolved = resolveSystemOneOutcomes({
    questions: asked,
    outcomes: decodeSystemOneAnswers({ plan, questions: asked, decisions }),
    excerptByAnchor: new Map(sources.map((source) => [source.id, source.text])),
    run: {
      model,
      completedAt: Temporal.Now.instant().toString({
        fractionalSecondDigits: 3,
      }),
      retrieved: text.retrieved || ranked.length > 0,
    },
  });
  const byColumn = new Map(
    resolved.settled.map((entry) => [entry.columnId, entry.outcome]),
  );
  const outcomes: ColumnOutcome[] = [];
  const remaining: ResearchRunColumn[] = [];
  for (const question of questions) {
    const outcome = byColumn.get(question.columnId);
    if (outcome === undefined) {
      remaining.push(question);
      continue;
    }
    outcomes.push({ columnId: question.columnId, outcome });
  }
  return { outcomes, remaining };
};

type AnswerOutcome =
  | {
      state: "answered";
      answer: FieldContent;
      run: CaseLawResearchAnswerRun;
    }
  | { state: "not_stated"; run: CaseLawResearchAnswerRun }
  | { state: "not_allowed" }
  | { state: "failed"; failureReason: CaseLawResearchAnswerFailureReason };

type ColumnOutcome = {
  columnId: SafeId<"caseLawResearchColumn">;
  outcome: AnswerOutcome;
};

const answerRowValues = (outcome: AnswerOutcome) => {
  switch (outcome.state) {
    case "answered":
      return {
        state: outcome.state,
        answer: outcome.answer,
        run: outcome.run,
        failureReason: null,
      };
    case "not_stated":
      return {
        state: outcome.state,
        answer: null,
        run: outcome.run,
        failureReason: null,
      };
    case "not_allowed":
      return {
        state: outcome.state,
        answer: null,
        run: null,
        failureReason: null,
      };
    case "failed":
      return {
        state: outcome.state,
        answer: null,
        run: null,
        failureReason: outcome.failureReason,
      };
    default: {
      outcome satisfies never;
      return panic(`Unhandled answer outcome: ${String(outcome)}`);
    }
  }
};

/**
 * Persist one decision's outcomes. A row is written only while this run still
 * owns it — pending, and stamped with this run's claim id — and only while the
 * column still asks the question this run answered: a question reworded
 * mid-run drops its old answers, and this write must not put an answer to the
 * old wording under the new heading. A run that stalled past the stale window
 * and woke up writes nothing, because a newer run has restamped its cells.
 */
const writeOutcomes = async (
  safeDb: SafeDb,
  input: Pick<RunResearchAnswersInput, "claim" | "columns" | "organizationId">,
  decisionId: SafeId<"caseLawDecision">,
  outcomes: readonly ColumnOutcome[],
): Promise<void> => {
  const { organizationId } = input;
  const askedByColumn = new Map(
    input.columns.map((column) => [column.columnId, column]),
  );
  const now = new Date();
  const written = await safeDb(async (tx) => {
    for (const { columnId, outcome } of outcomes) {
      const asked = askedByColumn.get(columnId);
      if (asked === undefined) {
        continue;
      }
      const values = answerRowValues(outcome);
      // SAFETY: bounded by the columns an organization may hold, inside one
      // transaction; each cell is its own row so a batch would be a VALUES join
      // of the same size.
      // db-await-in-loop: per-cell compare-and-set, each guarded by its own column snapshot and claim
      await tx
        .update(caseLawResearchAnswers)
        .set({ ...values, claimId: null, updatedAt: now })
        .where(
          and(
            eq(caseLawResearchAnswers.columnId, columnId),
            eq(caseLawResearchAnswers.decisionId, decisionId),
            eq(caseLawResearchAnswers.organizationId, organizationId),
            eq(caseLawResearchAnswers.state, "pending"),
            eq(caseLawResearchAnswers.claimId, input.claim.claimId),
            exists(
              tx
                .select({ one: sql`1` })
                .from(caseLawResearchColumns)
                .where(
                  and(
                    eq(caseLawResearchColumns.id, columnId),
                    eq(caseLawResearchColumns.question, asked.question),
                    // The whole content, not just its kind: an option removed
                    // from a select drops the column's answers too, and this
                    // write must not land one under the new list.
                    sql`${caseLawResearchColumns.content} = ${JSON.stringify(asked.content)}::text::jsonb`,
                  ),
                ),
            ),
          ),
        );
    }
  });
  if (Result.isError(written)) {
    throw written.error;
  }
};
