import { t } from "elysia";
import type { TSchema } from "elysia";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import type { CaseLawDecisionSummary } from "@stll/api-contract/case-law-decision-summary";

import { decisionHeadnotePreviewSchema } from "@/api/lib/case-law/decision-headnote-schema";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  boundedString,
  nullableBoundedString,
  nullableText,
  truncateTextBytes,
} from "@/api/lib/search/response-text-bounds";

const SUMMARY_TEXT_BYTES = {
  caseNumber: 1024,
  court: 2048,
  courtAbbreviation: 512,
  decisionDate: 128,
  decisionType: 512,
  publication: 2048,
} as const satisfies Record<
  Exclude<
    {
      [
        Key in keyof CaseLawDecisionSummary
      ]: CaseLawDecisionSummary[Key] extends string | null ? Key : never;
    }[keyof CaseLawDecisionSummary],
    "id" | "courtTier"
  >,
  number
>;

export const decisionSummaryResponseSchema = t.Object(
  {
    id: tSafeId("caseLawDecision"),
    caseNumber: boundedString(SUMMARY_TEXT_BYTES.caseNumber),
    court: boundedString(SUMMARY_TEXT_BYTES.court),
    courtAbbreviation: nullableBoundedString(
      SUMMARY_TEXT_BYTES.courtAbbreviation,
    ),
    courtTier: t.UnionEnum(COURT_TIER_LABELS),
    decisionDate: nullableBoundedString(SUMMARY_TEXT_BYTES.decisionDate),
    decisionType: nullableBoundedString(SUMMARY_TEXT_BYTES.decisionType),
    headnote: decisionHeadnotePreviewSchema,
    citationCount: t.Number(),
    publication: nullableBoundedString(SUMMARY_TEXT_BYTES.publication),
  } satisfies Record<keyof CaseLawDecisionSummary, TSchema>,
  { additionalProperties: false },
);

export const projectDecisionSummary = (
  decision: CaseLawDecisionSummary,
): CaseLawDecisionSummary => ({
  id: decision.id,
  caseNumber: truncateTextBytes(
    decision.caseNumber,
    SUMMARY_TEXT_BYTES.caseNumber,
  ),
  court: truncateTextBytes(decision.court, SUMMARY_TEXT_BYTES.court),
  courtAbbreviation: nullableText(
    decision.courtAbbreviation,
    SUMMARY_TEXT_BYTES.courtAbbreviation,
  ),
  courtTier: decision.courtTier,
  decisionDate: nullableText(
    decision.decisionDate,
    SUMMARY_TEXT_BYTES.decisionDate,
  ),
  decisionType: nullableText(
    decision.decisionType,
    SUMMARY_TEXT_BYTES.decisionType,
  ),
  headnote: decision.headnote,
  citationCount: decision.citationCount,
  publication: nullableText(
    decision.publication,
    SUMMARY_TEXT_BYTES.publication,
  ),
});
