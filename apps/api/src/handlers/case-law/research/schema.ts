import { t } from "elysia";
import type { Static } from "elysia";

import {
  CASE_LAW_RESEARCH_DISPOSITIONS,
  CASE_LAW_RESEARCH_QUERY_VERSION,
  CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH,
  CASE_LAW_RESEARCH_TABLE_NAME_MAX_LENGTH,
} from "@stll/api-contract";
import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import type {
  caseLawResearchAnswers,
  caseLawResearchColumns,
  caseLawResearchTables,
} from "@/api/db/schema";
import { tPaginationCursor, tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

/** Route-level mirror of `caseLawResearchSavedQuerySchema`; the handler re-parses. */
export const researchSavedQueryBodySchema = t.Object(
  {
    version: t.Literal(CASE_LAW_RESEARCH_QUERY_VERSION),
    query: t.String({ minLength: 1, maxLength: LIMITS.searchQueryMaxLength }),
    country: t.Optional(t.String({ maxLength: 3 })),
    court: t.Optional(t.String({ maxLength: 512 })),
    dateFrom: t.Optional(t.String({ format: "date" })),
    dateTo: t.Optional(t.String({ format: "date" })),
    decisionType: t.Optional(t.String({ maxLength: 128 })),
    language: t.Optional(t.String({ maxLength: 8 })),
    sourceId: t.Optional(tSafeId("caseLawSource")),
  },
  { additionalProperties: false },
);

export const researchTableNameSchema = t.String({
  minLength: 1,
  maxLength: CASE_LAW_RESEARCH_TABLE_NAME_MAX_LENGTH,
});

export const researchTableParamsSchema = t.Object({
  tableId: tSafeId("caseLawResearchTable"),
});

export const researchTableDecisionParamsSchema = t.Object({
  tableId: tSafeId("caseLawResearchTable"),
  decisionId: tSafeId("caseLawDecision"),
});

export const researchTableListQuerySchema = t.Object({
  cursor: t.Optional(tPaginationCursor()),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.caseLawResearchTablesPageSizeMax,
    }),
  ),
});

export const createResearchTableBodySchema = t.Object(
  {
    name: researchTableNameSchema,
    savedQuery: researchSavedQueryBodySchema,
  },
  { additionalProperties: false },
);

export const updateResearchTableBodySchema = t.Object(
  {
    name: t.Optional(researchTableNameSchema),
    savedQuery: t.Optional(researchSavedQueryBodySchema),
  },
  { additionalProperties: false },
);

export const setResearchTableDecisionBodySchema = t.Object(
  {
    decisionId: tSafeId("caseLawDecision"),
    disposition: t.UnionEnum(CASE_LAW_RESEARCH_DISPOSITIONS),
  },
  { additionalProperties: false },
);

export const researchColumnParamsSchema = t.Object({
  tableId: tSafeId("caseLawResearchTable"),
  columnId: tSafeId("caseLawResearchColumn"),
});

const researchQuestionSchema = t.String({
  minLength: 1,
  maxLength: CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH,
});

// Spelled out so Eden keeps the literal union; a mapped `t.Union` widens it.
// Not `t.UnionEnum` on the optional path: an absent optional UnionEnum coerces
// to its first member, which would silently retype every column on a rename.
const researchAnswerTypeSchema = t.Union([
  t.Literal("yes_no"),
  t.Literal("text"),
]);

// Both directions of the mirror: a member added to either side fails here.
type MirroredAnswerType = Static<typeof researchAnswerTypeSchema>;
true satisfies MirroredAnswerType extends CaseLawResearchAnswerType
  ? CaseLawResearchAnswerType extends MirroredAnswerType
    ? true
    : never
  : never;

export const createResearchColumnBodySchema = t.Object(
  {
    question: researchQuestionSchema,
    answerType: researchAnswerTypeSchema,
  },
  { additionalProperties: false },
);

export const updateResearchColumnBodySchema = t.Object(
  {
    question: t.Optional(researchQuestionSchema),
    answerType: t.Optional(researchAnswerTypeSchema),
  },
  { additionalProperties: false },
);

export const reorderResearchColumnsBodySchema = t.Object(
  {
    columnIds: t.Array(tSafeId("caseLawResearchColumn"), {
      minItems: 1,
      maxItems: LIMITS.caseLawResearchColumnsPerTable,
    }),
  },
  { additionalProperties: false },
);

export const runResearchAnswersBodySchema = t.Object(
  {
    /** Absent: every column of the table. */
    columnIds: t.Optional(
      t.Array(tSafeId("caseLawResearchColumn"), {
        minItems: 1,
        maxItems: LIMITS.caseLawResearchColumnsPerTable,
      }),
    ),
    decisionIds: t.Array(tSafeId("caseLawDecision"), {
      minItems: 1,
      maxItems: LIMITS.caseLawResearchRunDecisionsMax,
    }),
    /** Re-answer cells that already hold an answer. */
    force: t.Optional(t.Boolean()),
  },
  { additionalProperties: false },
);

export const lookupResearchAnswersBodySchema = t.Object(
  {
    decisionIds: t.Array(tSafeId("caseLawDecision"), {
      minItems: 1,
      maxItems: LIMITS.caseLawResearchAnswersLookupDecisionsMax,
    }),
  },
  { additionalProperties: false },
);

export const toResearchColumnResponse = (
  row: typeof caseLawResearchColumns.$inferSelect,
) => ({
  id: row.id,
  tableId: row.tableId,
  position: row.position,
  question: row.question,
  answerType: row.answerType,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toResearchAnswerResponse = (
  row: typeof caseLawResearchAnswers.$inferSelect,
  now: Date,
) => ({
  columnId: row.columnId,
  decisionId: row.decisionId,
  state: row.state,
  answer: row.answer,
  confidence: row.confidence,
  run: row.run,
  failureReason: row.failureReason,
  updatedAt: row.updatedAt.toISOString(),
  /**
   * A pending cell whose run went quiet past the stale window: the process
   * serving it is gone, and a new run may claim it. Decided on the server's
   * clock so the client never compares timestamps of its own.
   */
  stale:
    row.state === "pending" &&
    now.getTime() - row.updatedAt.getTime() >
      LIMITS.caseLawResearchPendingStaleMs,
});

export const toResearchTableResponse = (
  row: typeof caseLawResearchTables.$inferSelect,
) => ({
  id: row.id,
  name: row.name,
  ownerUserId: row.ownerUserId,
  savedQuery: row.savedQuery,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
