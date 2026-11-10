/**
 * The fact details a fact candidate proposes, in the shape the item's fact
 * details take once the candidate is accepted. Every field is optional: what
 * the producer does not state stays null, and an unstated scoring is written
 * as `included` on acceptance.
 */

import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";

import type { legalListGenerationCandidates } from "@/api/db/schema";
import {
  canonicalFactDate,
  FACT_CONFIDENCES,
  FACT_DATE_PRECISIONS,
  FACT_DETAIL_LIMITS,
  FACT_SCORING,
} from "@/api/lib/lists/fact-details";

const boundedText = (maxLength: number) =>
  v.optional(
    v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(maxLength))),
  );

// Strict, so a misspelt field is refused rather than silently dropped.
export const candidateFactDetailsSchema = v.strictObject({
  occurredOn: v.optional(
    v.nullable(
      v.object({
        date: apiDateSchema,
        precision: v.picklist(FACT_DATE_PRECISIONS),
      }),
    ),
  ),
  evidenceKind: boundedText(FACT_DETAIL_LIMITS.EVIDENCE_KIND_MAX),
  medium: boundedText(FACT_DETAIL_LIMITS.MEDIUM_MAX),
  confidence: v.optional(v.nullable(v.picklist(FACT_CONFIDENCES))),
  interpretationNote: boundedText(FACT_DETAIL_LIMITS.INTERPRETATION_NOTE_MAX),
  scoring: v.optional(v.nullable(v.picklist(FACT_SCORING))),
});

export type CandidateFactDetails = v.InferOutput<
  typeof candidateFactDetailsSchema
>;

type CandidateRow = typeof legalListGenerationCandidates.$inferInsert;

export type CandidateFactDetailColumns = Required<
  Pick<
    CandidateRow,
    | "occurredOn"
    | "occurredOnPrecision"
    | "evidenceKind"
    | "medium"
    | "confidence"
    | "interpretationNote"
    | "scoring"
  >
>;

export const NO_CANDIDATE_FACT_DETAILS: CandidateFactDetailColumns = {
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: null,
  interpretationNote: null,
  scoring: null,
};

/** Column values for a candidate's proposed fact details; a partial date is
 *  stored as its first day, like the item's own row. */
export const candidateFactDetailColumns = (
  details: CandidateFactDetails,
): CandidateFactDetailColumns => ({
  occurredOn: details.occurredOn
    ? canonicalFactDate(details.occurredOn.date, details.occurredOn.precision)
    : null,
  occurredOnPrecision: details.occurredOn?.precision ?? null,
  evidenceKind: details.evidenceKind ?? null,
  medium: details.medium ?? null,
  confidence: details.confidence ?? null,
  interpretationNote: details.interpretationNote ?? null,
  scoring: details.scoring ?? null,
});
