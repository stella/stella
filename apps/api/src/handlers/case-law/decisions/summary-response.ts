import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import type { CaseLawDecisionSummary } from "@stll/api-contract/case-law-decision-summary";
import { caseLawTextStatusSchema } from "@stll/api-contract/case-law-fulltext-state";

import { decisionHeadnotePreviewSchema } from "@/api/lib/case-law/decision-headnote-schema";
import { resourceIdSchema } from "@/api/lib/custom-schema";
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
    "id" | "courtTier" | "textState"
  >,
  number
>;

export const decisionSummaryResponseSchema = v.object({
  textState: v.nullable(caseLawTextStatusSchema),
  id: resourceIdSchema("caseLawDecision"),
  caseNumber: boundedString(SUMMARY_TEXT_BYTES.caseNumber),
  court: boundedString(SUMMARY_TEXT_BYTES.court),
  courtAbbreviation: nullableBoundedString(
    SUMMARY_TEXT_BYTES.courtAbbreviation,
  ),
  courtTier: v.picklist([...COURT_TIER_LABELS]),
  decisionDate: nullableBoundedString(SUMMARY_TEXT_BYTES.decisionDate),
  decisionType: nullableBoundedString(SUMMARY_TEXT_BYTES.decisionType),
  headnote: decisionHeadnotePreviewSchema,
  citationCount: v.number(),
  publication: nullableBoundedString(SUMMARY_TEXT_BYTES.publication),
} satisfies Record<keyof CaseLawDecisionSummary, v.GenericSchema>);

export const projectDecisionSummary = (
  decision: CaseLawDecisionSummary,
): CaseLawDecisionSummary => ({
  textState: decision.textState,
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
