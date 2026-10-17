import { and, inArray, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawCitationDoctrineReviews,
  caseLawCitationReviews,
  caseLawDecisions,
} from "@/api/db/schema";
import type { caseLawCitations } from "@/api/db/schema";
import { CITATION_REVIEW_ORIGIN } from "@/api/handlers/case-law/polarity/consts";
import { citationTextRevisionFingerprintSql } from "@/api/lib/case-law/citation-text-revision";

type ReviewTextEligibility = {
  origin: SQLWrapper;
  citingDecisionId: SQLWrapper;
  textRevisionSha256: SQLWrapper;
};

/** Only a review eligible for the current text can supply a label or claim precedence. */
export const reviewTextEligibleSql = ({
  origin,
  citingDecisionId,
  textRevisionSha256,
}: ReviewTextEligibility): SQL =>
  // sql-perf-allow: bounded by the indexed citing decision and citation key of the current page or input batch
  sql`(${origin} = ${CITATION_REVIEW_ORIGIN.HUMAN_REVIEW}
  OR (${textRevisionSha256} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ${caseLawDecisions} AS review_text_revision
       WHERE review_text_revision.id = ${citingDecisionId}
         AND ${textRevisionSha256} = ${citationTextRevisionFingerprintSql({
           contentHash: sql`review_text_revision.content_hash`,
           sections: sql`review_text_revision.sections`,
         })}
    )))`;

const storedReviewTextEligibleSql = reviewTextEligibleSql({
  origin: caseLawCitationReviews.origin,
  citingDecisionId: caseLawCitationReviews.citingDecisionId,
  textRevisionSha256: caseLawCitationReviews.textRevisionSha256,
});

type CitationInsert = typeof caseLawCitations.$inferInsert;

type CitationIdentity = {
  citingDecisionId: SQLWrapper;
  citationKey: SQLWrapper;
};

/**
 * True for a citation row no review covers. A null key never equals a
 * review's key, so a keyless row always counts as unreviewed.
 */
export const unreviewedCitationSql = ({
  citingDecisionId,
  citationKey,
}: CitationIdentity): SQL => sql`NOT EXISTS (
  SELECT 1 FROM ${caseLawCitationReviews}
   WHERE ${caseLawCitationReviews.citingDecisionId} = ${citingDecisionId}
     AND ${caseLawCitationReviews.citationKey} = ${citationKey}
     AND ${storedReviewTextEligibleSql}
)`;

const identityOf = (citingDecisionId: string, citationKey: string): string =>
  `${citingDecisionId}\u0000${citationKey}`;

/**
 * Give each row a review covers the reviewed polarity, attributed to no rule.
 * One read for the whole set, whatever its size.
 */
export const applyCitationReviews = async (
  tx: Transaction,
  rows: readonly CitationInsert[],
): Promise<readonly CitationInsert[]> => {
  const decisionIds = [...new Set(rows.map((row) => row.citingDecisionId))];
  const keys = [
    ...new Set(
      rows.flatMap((row) =>
        typeof row.citationKey === "string" ? [row.citationKey] : [],
      ),
    ),
  ];
  if (keys.length === 0) {
    return rows;
  }
  const reviews = await tx
    .select({
      citingDecisionId: caseLawCitationReviews.citingDecisionId,
      citationKey: caseLawCitationReviews.citationKey,
      polarity: caseLawCitationReviews.polarity,
    })
    .from(caseLawCitationReviews)
    .where(
      and(
        inArray(caseLawCitationReviews.citingDecisionId, decisionIds),
        inArray(caseLawCitationReviews.citationKey, keys),
        storedReviewTextEligibleSql,
      ),
    );
  if (reviews.length === 0) {
    return rows;
  }
  const reviewed = new Map(
    reviews.map((review) => [
      identityOf(review.citingDecisionId, review.citationKey),
      review.polarity,
    ]),
  );
  return rows.map((row) => {
    const polarity =
      row.citationKey === null || row.citationKey === undefined
        ? undefined
        : reviewed.get(identityOf(row.citingDecisionId, row.citationKey));
    return polarity === undefined
      ? row
      : {
          ...row,
          polarity,
          polarityRuleId: null,
          polaritySource: "review",
          polarityClassifierVersion: null,
          polarityEvidenceWindows: null,
          polarityConfidence: null,
        };
  });
};

/** Restore doctrinal reviews independently of stance after a citation refresh. */
export const applyDoctrineReviews = async (
  tx: Transaction,
  rows: readonly CitationInsert[],
): Promise<readonly CitationInsert[]> => {
  const decisionIds = [...new Set(rows.map((row) => row.citingDecisionId))];
  const keys = [
    ...new Set(
      rows.flatMap((row) =>
        typeof row.citationKey === "string" ? [row.citationKey] : [],
      ),
    ),
  ];
  if (keys.length === 0) {
    return rows;
  }
  const reviews = await tx
    .select({
      citingDecisionId: caseLawCitationDoctrineReviews.citingDecisionId,
      citationKey: caseLawCitationDoctrineReviews.citationKey,
      doctrinalTreatment: caseLawCitationDoctrineReviews.doctrinalTreatment,
    })
    .from(caseLawCitationDoctrineReviews)
    .where(
      and(
        inArray(caseLawCitationDoctrineReviews.citingDecisionId, decisionIds),
        inArray(caseLawCitationDoctrineReviews.citationKey, keys),
        reviewTextEligibleSql({
          origin: caseLawCitationDoctrineReviews.origin,
          citingDecisionId: caseLawCitationDoctrineReviews.citingDecisionId,
          textRevisionSha256: caseLawCitationDoctrineReviews.textRevisionSha256,
        }),
      ),
    );
  const reviewed = new Map(
    reviews.map((review) => [
      identityOf(review.citingDecisionId, review.citationKey),
      review.doctrinalTreatment,
    ]),
  );
  return rows.map((row) => {
    const doctrinalTreatment =
      row.citationKey === null || row.citationKey === undefined
        ? undefined
        : reviewed.get(identityOf(row.citingDecisionId, row.citationKey));
    return doctrinalTreatment === undefined
      ? row
      : { ...row, doctrinalTreatment };
  });
};
