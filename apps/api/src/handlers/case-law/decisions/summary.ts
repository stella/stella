import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { TSchema } from "elysia";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import type { CaseLawDecisionSummary } from "@stll/api-contract/case-law-decision-summary";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import {
  courtPresentation,
  readCourtRegistry,
} from "@/api/lib/case-law/court-presentation";
import { decisionHeadnotePreviewSchema } from "@/api/lib/case-law/decision-headnote-schema";
import { readDecisionHeadnote } from "@/api/lib/case-law/decision-text";
import { loadPublicCourtWeightsWithin } from "@/api/lib/case-law/public-case-law-config";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import {
  publisherHeadnoteMetadataSql,
  publisherKeywordsMetadataSql,
} from "@/api/lib/case-law/publisher-summary";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  boundedString,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";

export const decisionSummaryResponseSchema = t.Object(
  {
    id: tSafeId("caseLawDecision"),
    caseNumber: boundedString(1024),
    court: boundedString(2048),
    courtAbbreviation: nullableBoundedString(512),
    courtTier: t.UnionEnum(COURT_TIER_LABELS),
    decisionDate: nullableBoundedString(128),
    decisionType: nullableBoundedString(512),
    headnote: decisionHeadnotePreviewSchema,
    citationCount: t.Number(),
    publication: nullableBoundedString(2048),
  } satisfies Record<keyof CaseLawDecisionSummary, TSchema>,
  { additionalProperties: false },
);

/** A bounded, stored-only projection for citation cards. */
export const readDecisionSummary = async (
  subject: RedistributableDecisionSubject,
): Promise<CaseLawDecisionSummary> => {
  const [decision, publication, courtWeights] = await Promise.all([
    subject.tx
      .select({
        id: publishedCaseLawDecisions.id,
        caseNumber: publishedCaseLawDecisions.caseNumber,
        court: publishedCaseLawDecisions.court,
        courtId: publishedCaseLawDecisions.courtId,
        country: publishedCaseLawDecisions.country,
        ecli: publishedCaseLawDecisions.ecli,
        decisionDate: publishedCaseLawDecisions.decisionDate,
        decisionType: publishedCaseLawDecisions.decisionType,
        headnote: publisherHeadnoteMetadataSql(
          publishedCaseLawDecisions.metadata,
        ),
        keywords: publisherKeywordsMetadataSql(
          publishedCaseLawDecisions.metadata,
        ),
        citationCount: publishedCaseLawDecisions.citationCount,
      })
      .from(publishedCaseLawDecisions)
      .where(eq(publishedCaseLawDecisions.id, subject.id))
      .limit(1)
      .then((rows) => rows.at(0)),
    subject.tx
      .select({ value: caseLawDecisionIdentifiers.value })
      .from(caseLawDecisionIdentifiers)
      .where(
        and(
          eq(caseLawDecisionIdentifiers.decisionId, subject.id),
          eq(
            caseLawDecisionIdentifiers.type,
            DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0)),
    readCourtRegistry(
      async () => await loadPublicCourtWeightsWithin(subject.tx),
    ),
  ]);

  // The public-subject gate found this row in the same transaction.
  if (decision === undefined) {
    return panic("Gated case-law decision disappeared during summary read");
  }
  const presentation = courtPresentation(courtWeights, decision);
  return {
    id: decision.id,
    caseNumber: decision.caseNumber,
    court: decision.court,
    courtAbbreviation: presentation.courtAbbreviation,
    courtTier: presentation.courtTier,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType,
    headnote: readDecisionHeadnote({
      headnote: decision.headnote,
      keywords: decision.keywords,
    }),
    citationCount: decision.citationCount,
    publication: publication?.value ?? null,
  };
};
