import { and, inArray, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawCitationReviews } from "@/api/db/schema";
import type { caseLawCitations } from "@/api/db/schema";

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
      : { ...row, polarity, polarityRuleId: null };
  });
};
