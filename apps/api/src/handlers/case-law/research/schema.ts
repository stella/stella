import { t } from "elysia";
import type { Static } from "elysia";

import {
  CASE_LAW_RESEARCH_COLUMN_OPTIONS_MAX,
  CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH,
} from "@stll/api-contract";
import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import type { caseLawResearchAnswers } from "@/api/db/schema";
import { parseStoredAnswerContent } from "@/api/lib/case-law/research-answers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const researchColumnParamsSchema = t.Object({
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
  t.Literal("text"),
  t.Literal("single-select"),
  t.Literal("multi-select"),
  t.Literal("date"),
  t.Literal("int"),
]);

/** The same option shape a property's select carries. */
const researchColumnOptionSchema = t.Object({
  color: t.String({ minLength: 1, maxLength: 64 }),
  value: t.String({ minLength: 1, maxLength: 1000 }),
});

const researchColumnOptionsSchema = t.Array(researchColumnOptionSchema, {
  maxItems: CASE_LAW_RESEARCH_COLUMN_OPTIONS_MAX,
});

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
    /** Select kinds only; the handler refuses them on any other kind. */
    options: t.Optional(researchColumnOptionsSchema),
  },
  { additionalProperties: false },
);

// A kind change carries its whole content: `options` without `answerType` has
// no kind to belong to, and the handler refuses it rather than dropping it.
export const updateResearchColumnBodySchema = t.Object(
  {
    question: t.Optional(researchQuestionSchema),
    answerType: t.Optional(researchAnswerTypeSchema),
    options: t.Optional(researchColumnOptionsSchema),
  },
  { additionalProperties: false },
);

// The held ceiling, not the create cap: the order must name every column the
// organization keeps, and a grandfathered set is larger than what may be added.
export const reorderResearchColumnsBodySchema = t.Object(
  {
    columnIds: t.Array(tSafeId("caseLawResearchColumn"), {
      minItems: 1,
      maxItems: LIMITS.caseLawResearchColumnsPerOrganizationMax,
    }),
  },
  { additionalProperties: false },
);

export const runResearchAnswersBodySchema = t.Object(
  {
    /** Absent: every column the organization keeps. */
    columnIds: t.Optional(
      t.Array(tSafeId("caseLawResearchColumn"), {
        minItems: 1,
        maxItems: LIMITS.caseLawResearchColumnsPerOrganizationMax,
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

export const toResearchAnswerResponse = (
  row: typeof caseLawResearchAnswers.$inferSelect,
  now: Date,
) => ({
  columnId: row.columnId,
  decisionId: row.decisionId,
  state: row.state,
  // JSONB written by this deployment, read back through the field-content
  // schema: a cell that drifted renders as the union's error arm rather than
  // reaching the client as an unknown shape.
  answer: row.answer === null ? null : parseStoredAnswerContent(row.answer),
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
