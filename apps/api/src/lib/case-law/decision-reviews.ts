import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { PUBLIC_CASE_LAW_PAGE_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import {
  DECISION_REVIEW_LINK_LIMIT,
  type DecisionReviewLink,
  type DecisionReviews,
} from "@stll/api-contract/case-law-reviews";

import {
  caseLawDecisionReviews,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution";
import { readCappedByGroup } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";

const higher = alias(publishedCaseLawDecisions, "reviewing_decision");
const higherSource = alias(caseLawSources, "reviewing_source");
const lower = alias(publishedCaseLawDecisions, "reviewed_decision");
const lowerSource = alias(caseLawSources, "reviewed_source");

/** Conflicting proceedings do not establish a partial disposition of one appeal. */
export const decisionReviewStatus = (
  links: readonly DecisionReviewLink[],
): DecisionReviews["status"] => {
  if (links.some(({ evidenceStatus }) => evidenceStatus === "conflict")) {
    return "unknown";
  }
  const outcomes = new Set(links.map(({ outcome }) => outcome));
  if (outcomes.size === 0) {
    return "none_found";
  }
  if (outcomes.size !== 1) {
    return "unknown";
  }
  const outcome =
    links.at(0)?.outcome ?? panic("Nonempty review outcomes have no link");
  return outcome === "pending" ? "under_review" : outcome;
};

type ReadDecisionReviewsWithinOptions = {
  decisionIds: readonly SafeId<"caseLawDecision">[];
  tx: Pick<CaseLawPublicReadTransaction, "select">;
  countries?: readonly string[];
};

/** Two statements per page; each subject uses indexed, independently capped edges. */
export const readDecisionReviewsWithin = async ({
  decisionIds,
  tx,
  countries = PUBLIC_CASE_LAW_PAGE_COUNTRIES,
}: ReadDecisionReviewsWithinOptions): Promise<
  Map<SafeId<"caseLawDecision">, DecisionReviews>
> => {
  if (decisionIds.length > LIMITS.caseLawSearchPageSizeMax) {
    return panic("Review hydration exceeds the decision page limit");
  }
  const result = new Map<SafeId<"caseLawDecision">, DecisionReviews>();
  if (decisionIds.length === 0) {
    return result;
  }
  const rowsFor = async (direction: "incoming" | "outgoing") => {
    // Cap the indexed edge scan before publication joins: hidden records must
    // not turn a bounded summary into a walk of the whole incoming graph.
    const edgeScan = tx
      .select({
        reviewingDecisionId: caseLawDecisionReviews.reviewingDecisionId,
        reviewedDecisionId: caseLawDecisionReviews.reviewedDecisionId,
        reviewedCaseNumber: caseLawDecisionReviews.reviewedCaseNumber,
        reviewedCourt: caseLawDecisionReviews.reviewedCourt,
        reviewedDecisionDate: caseLawDecisionReviews.reviewedDecisionDate,
        outcome: caseLawDecisionReviews.outcome,
        source: caseLawDecisionReviews.source,
        evidenceStatus: caseLawDecisionReviews.evidenceClassification,
      })
      .from(caseLawDecisionReviews)
      .where(
        eq(
          direction === "incoming"
            ? caseLawDecisionReviews.reviewedDecisionId
            : caseLawDecisionReviews.reviewingDecisionId,
          publishedCaseLawDecisions.id,
        ),
      )
      .orderBy(
        asc(caseLawDecisionReviews.reviewingDecisionId),
        asc(caseLawDecisionReviews.reviewedCourt),
        asc(caseLawDecisionReviews.reviewedCaseNumber),
        asc(caseLawDecisionReviews.reviewedDecisionDate),
      );
    return await readCappedByGroup(edgeScan, {
      cap: DECISION_REVIEW_LINK_LIMIT,
      readRows: async (limited) => {
        const edges = limited.as("review_edges");
        return await tx
          .select({
            subjectId: publishedCaseLawDecisions.id,
            reviewer: {
              reviewingDecisionId: higher.id,
              reviewingCaseNumber: higher.caseNumber,
              reviewingCourt: higher.court,
            },
            visible: sql<boolean>`${higherSource.id} IS NOT NULL`,
            link: {
              // A public header can name an unavailable target; its private id cannot escape.
              reviewedDecisionId: sql<SafeId<"caseLawDecision"> | null>`CASE WHEN ${lowerSource.id} IS NOT NULL THEN ${lower.id} ELSE NULL END`,
              reviewedCaseNumber: edges.reviewedCaseNumber,
              reviewedCourt: edges.reviewedCourt,
              reviewedDecisionDate: edges.reviewedDecisionDate,
              outcome: edges.outcome,
              source: edges.source,
              evidenceStatus: edges.evidenceStatus,
            },
          })
          .from(publishedCaseLawDecisions)
          .innerJoin(
            caseLawSources,
            and(
              eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
              redistributableCaseLawSourceFor(caseLawSources.descriptor),
            ),
          )
          .innerJoinLateral(edges, sql`true`)
          .leftJoin(
            higher,
            and(
              eq(higher.id, edges.reviewingDecisionId),
              inArray(higher.country, [...countries]),
            ),
          )
          .leftJoin(
            higherSource,
            and(
              eq(higherSource.id, higher.sourceId),
              redistributableCaseLawSourceFor(higherSource.descriptor),
            ),
          )
          .leftJoin(
            lower,
            and(
              eq(lower.id, edges.reviewedDecisionId),
              inArray(lower.country, [...countries]),
            ),
          )
          .leftJoin(
            lowerSource,
            and(
              eq(lowerSource.id, lower.sourceId),
              redistributableCaseLawSourceFor(lowerSource.descriptor),
            ),
          )
          .where(
            and(
              inArray(publishedCaseLawDecisions.id, [...decisionIds]),
              inArray(publishedCaseLawDecisions.country, [...countries]),
            ),
          )
          .limit(decisionIds.length * (DECISION_REVIEW_LINK_LIMIT + 1));
      },
      groupKeyOf: ({ subjectId }) => subjectId,
    });
  };
  const incoming = await rowsFor("incoming");
  const outgoing = await rowsFor("outgoing");
  const bySubject = new Map<
    SafeId<"caseLawDecision">,
    {
      reviewedBy: DecisionReviewLink[];
      reviews: DecisionReviewLink[];
    }
  >();
  for (const id of decisionIds) {
    bySubject.set(id, {
      reviewedBy: [],
      reviews: [],
    });
  }
  for (const { subjectId, link, reviewer, visible } of incoming.rows) {
    const evidence =
      bySubject.get(subjectId) ?? panic("Unrequested review subject");
    if (visible && reviewer !== null) {
      evidence.reviewedBy.push({ ...link, ...reviewer });
    }
  }
  for (const { subjectId, link, reviewer, visible } of outgoing.rows) {
    const evidence =
      bySubject.get(subjectId) ?? panic("Unrequested review subject");
    if (visible && reviewer !== null) {
      evidence.reviews.push({ ...link, ...reviewer });
    }
  }
  for (const [id, evidence] of bySubject) {
    const reviewedByTruncated = incoming.overflowed.has(id);
    const status = reviewedByTruncated
      ? "unknown"
      : decisionReviewStatus(evidence.reviewedBy);
    const fields = {
      basis: "available_corpus",
      reviewedBy: evidence.reviewedBy,
      reviews: evidence.reviews,
      reviewedByTruncated,
      reviewsTruncated: outgoing.overflowed.has(id),
    } as const;
    result.set(
      id,
      status === "none_found"
        ? { status, reason: "no_link_in_corpus", ...fields }
        : { status, ...fields },
    );
  }
  return result;
};

type ReadDecisionReviewsOptions = Omit<
  ReadDecisionReviewsWithinOptions,
  "tx"
> & { caseLawDb: CaseLawPublicReadDb };
export const readDecisionReviews = async ({
  caseLawDb,
  ...options
}: ReadDecisionReviewsOptions) =>
  await caseLawDb(
    async (tx) => await readDecisionReviewsWithin({ ...options, tx }),
  );

export const requireDecisionReviews = (
  reviews: ReadonlyMap<SafeId<"caseLawDecision">, DecisionReviews>,
  decisionId: SafeId<"caseLawDecision">,
): DecisionReviews =>
  reviews.get(decisionId) ??
  panic("Decision review hydration omitted a requested decision");
