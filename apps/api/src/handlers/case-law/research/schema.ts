import * as v from "valibot";

import {
  CASE_LAW_RESEARCH_COLUMN_OPTIONS_MAX,
  CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH,
  CASE_LAW_RESEARCH_SUGGEST_SAMPLES_MAX,
} from "@stll/api-contract";
import type { CaseLawResearchAnswerType } from "@stll/api-contract";
import { apiDateSchema } from "@stll/api-contract/api-date";

import type { caseLawResearchAnswers } from "@/api/db/schema";
import { parseStoredAnswerContent } from "@/api/lib/case-law/research-answers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const researchColumnParamsSchema = v.object({
  columnId: resourceIdSchema("caseLawResearchColumn"),
});

const researchQuestionSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH),
);

// Spelled out, and bound to the contract's list by `MirroredAnswerType` below.
// No default: an absent answer type on a rename leaves the column's type as it
// is.
const researchAnswerTypeSchema = v.picklist([
  "text",
  "single-select",
  "multi-select",
  "date",
  "int",
]);

/** The same option shape a property's select carries. */
const researchColumnOptionSchema = v.object({
  color: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
});

const researchColumnOptionsSchema = v.pipe(
  v.array(researchColumnOptionSchema),
  v.maxLength(CASE_LAW_RESEARCH_COLUMN_OPTIONS_MAX),
);

// Both directions of the mirror: a member added to either side fails here.
type MirroredAnswerType = v.InferOutput<typeof researchAnswerTypeSchema>;
true satisfies MirroredAnswerType extends CaseLawResearchAnswerType
  ? CaseLawResearchAnswerType extends MirroredAnswerType
    ? true
    : never
  : never;

export const createResearchColumnBodySchema = v.strictObject({
  question: researchQuestionSchema,
  answerType: researchAnswerTypeSchema,
  options: v.optional(researchColumnOptionsSchema),
});

// A kind change carries its whole content: `options` without `answerType` has
// no kind to belong to, and the handler refuses it rather than dropping it.
export const updateResearchColumnBodySchema = v.strictObject({
  question: v.optional(researchQuestionSchema),
  answerType: v.optional(researchAnswerTypeSchema),
  options: v.optional(researchColumnOptionsSchema),
});

// The held ceiling, not the create cap: the order must name every column the
// organization keeps, and a grandfathered set is larger than what may be added.
export const reorderResearchColumnsBodySchema = v.strictObject({
  columnIds: v.pipe(
    v.array(resourceIdSchema("caseLawResearchColumn")),
    v.minLength(1),
    v.maxLength(LIMITS.caseLawResearchColumnsPerOrganizationMax),
  ),
});

export const runResearchAnswersBodySchema = v.strictObject({
  columnIds: v.optional(
    v.pipe(
      v.array(resourceIdSchema("caseLawResearchColumn")),
      v.minLength(1),
      v.maxLength(LIMITS.caseLawResearchColumnsPerOrganizationMax),
    ),
  ),
  decisionIds: v.pipe(
    v.array(resourceIdSchema("caseLawDecision")),
    v.minLength(1),
    v.maxLength(LIMITS.caseLawResearchRunDecisionsMax),
  ),
  force: v.optional(v.boolean()),
});

/**
 * The search a suggestion is written for, and the rows it may be grounded in.
 *
 * The client never sends decision text: it names the decisions it has on
 * screen and the server reads their published headnotes through the same
 * public, redistribution-gated read the answer runner uses. `country` and
 * `query` are absent where the listing has neither — a matter's linked
 * decisions span jurisdictions and were never searched for.
 */
export const suggestResearchColumnPromptBodySchema = v.strictObject({
  question: researchQuestionSchema,
  answerKind: researchAnswerTypeSchema,
  options: v.optional(researchColumnOptionsSchema),
  instruction: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  country: v.optional(v.pipe(v.string(), v.minLength(2), v.maxLength(3))),
  query: v.optional(
    v.pipe(v.string(), v.maxLength(LIMITS.searchQueryMaxLength)),
  ),
  filters: v.strictObject({
    court: v.optional(v.pipe(v.string(), v.maxLength(512))),
    decisionType: v.optional(v.pipe(v.string(), v.maxLength(128))),
    dateFrom: v.optional(apiDateSchema),
    dateTo: v.optional(apiDateSchema),
    language: v.optional(v.pipe(v.string(), v.maxLength(8))),
  }),
  decisionIds: v.pipe(
    v.array(resourceIdSchema("caseLawDecision")),
    v.maxLength(CASE_LAW_RESEARCH_SUGGEST_SAMPLES_MAX),
  ),
});

export const lookupResearchAnswersBodySchema = v.strictObject({
  decisionIds: v.pipe(
    v.array(resourceIdSchema("caseLawDecision")),
    v.minLength(1),
    v.maxLength(LIMITS.caseLawResearchAnswersLookupDecisionsMax),
  ),
});

export const toResearchAnswerResponse = (
  row: typeof caseLawResearchAnswers.$inferSelect,
  now: Date,
  marker: string | null,
) => {
  const identity = {
    columnId: row.columnId,
    decisionId: row.decisionId,
    updatedAt: row.updatedAt.toISOString(),
  };
  if (marker !== null) {
    return {
      ...identity,
      state: "withdrawn" as const,
      withdrawnMarker: marker,
      answer: null,
      run: null,
      failureReason: null,
      stale: false,
    };
  }
  return {
    ...identity,
    state: row.state,
    withdrawnMarker: null,
    // Persisted JSON follows the same field-content boundary as matter cells.
    answer: row.answer === null ? null : parseStoredAnswerContent(row.answer),
    run: row.run,
    failureReason: row.failureReason,
    stale:
      row.state === "pending" &&
      now.getTime() - row.updatedAt.getTime() >
        LIMITS.caseLawResearchPendingStaleMs,
  };
};
