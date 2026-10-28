import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { decisionDocketGrammarForJurisdiction } from "@stll/api-contract/decision-docket-grammar";
import { readDecisionDocketReference } from "@stll/api-contract/decision-docket-reference";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisionReviews, caseLawDecisions } from "@/api/db/schema";
import type { CitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { planCzechAppealReviews } from "@/api/handlers/case-law/ingestion/cz-appeal-reviews";
import { CASE_LAW_REVIEW_EXTRACTION_VERSION } from "@/api/handlers/case-law/ingestion/review-outcomes";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import type { SystemAuditCounts } from "@/api/lib/system-audit/actors";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

/** Null preserves existing edges when an observation supplies no new evidence. */
type PlanDecisionReviewsOptions = {
  country: string;
  sections: readonly DecisionSection[];
  metadata: Record<string, unknown>;
};

export const planDecisionReviews = ({
  country,
  sections,
  metadata,
}: PlanDecisionReviewsOptions) => {
  if (country !== "CZE") {
    return null;
  }
  const header = sections
    .filter((section) => section.type === "header")
    .map((section) => section.text)
    .join("\n");
  const publisherReviews = metadata["publisherReviews"];
  if (
    header.length === 0 &&
    (publisherReviews === undefined ||
      (Array.isArray(publisherReviews) && publisherReviews.length === 0))
  ) {
    return null;
  }
  const holding = sections
    .filter((section) => section.type === "ruling")
    .map((section) => section.text)
    .join("\n");
  return planCzechAppealReviews({ header, holding, metadata }).map((review) => {
    const reference = readDecisionDocketReference(review.reviewedCaseNumber, {
      grammar: decisionDocketGrammarForJurisdiction("CZE"),
    });
    if (reference === null) {
      return panic(
        "Czech appeal extraction produced an invalid reviewed docket",
      );
    }
    return {
      ...review,
      reviewedCitationKey: bareCitationKey(reference.family.formatted),
      reviewedDocketFamilyKey: reference.family.canonical,
      reviewedSheetNumber:
        reference.selector.kind === "sheet" ? reference.selector.value : null,
      parserVersion: CASE_LAW_REVIEW_EXTRACTION_VERSION,
    };
  });
};

type WriteDecisionReviewsOptions = {
  decisionId: SafeId<"caseLawDecision">;
  country: string;
  /** The identity locked before an update, or null for an insert/preserved identity. */
  previousIdentity: Pick<
    typeof caseLawDecisions.$inferSelect,
    "country" | "court" | "docketFamilyKey"
  > | null;
  reviews: ReturnType<typeof planDecisionReviews>;
};

/**
 * Replay replaces the source decision's extracted edges, then settles both
 * its targets and references affected by this arrival/identity change.
 * Existing graph serialization orders concurrent target arrivals and reviews.
 * A two-row candidate cap makes ambiguity explicit instead of picking a row.
 */
export const writeDecisionReviews = async (
  tx: CitationGraphTransaction<Transaction>,
  {
    decisionId,
    country,
    previousIdentity,
    reviews,
  }: WriteDecisionReviewsOptions,
) => {
  if (country !== "CZE" && previousIdentity?.country !== "CZE") {
    return;
  }
  // This invocation is one tenantless reconciliation operation, including lazy reparses.
  const auditSubject = createSafeId<"systemScriptRun">();
  const counts = {
    removedReviews: 0,
    writtenReviews: 0,
    resolvedReviews: 0,
    extractionVersions: 0,
  } satisfies SystemAuditCounts<"system:case-law-review-reconcile">;
  if (country !== "CZE") {
    counts.removedReviews += executedRows(
      await tx.execute(sql`DELETE FROM ${caseLawDecisionReviews}
      WHERE reviewing_decision_id = ${decisionId}::uuid
      RETURNING 1`),
    ).length;

    counts.extractionVersions += executedRows(
      await tx.execute(sql`UPDATE ${caseLawDecisions}
      SET review_extraction_version = NULL WHERE id = ${decisionId}::uuid
        AND review_extraction_version IS NOT NULL
      RETURNING 1`),
    ).length;
  }
  if (country === "CZE" && reviews !== null) {
    counts.removedReviews += executedRows(
      await tx.execute(sql`DELETE FROM ${caseLawDecisionReviews} stored
      WHERE reviewing_decision_id = ${decisionId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(reviews)}::text::jsonb)
            AS incoming("reviewedCourt" text, "reviewedCaseNumber" text, "reviewedDecisionDate" date)
          WHERE incoming."reviewedCourt" = stored.reviewed_court
            AND incoming."reviewedCaseNumber" = stored.reviewed_case_number
            AND incoming."reviewedDecisionDate" IS NOT DISTINCT FROM stored.reviewed_decision_date
        )
      RETURNING 1`),
    ).length;
    if (reviews.length > 0) {
      counts.writtenReviews += executedRows(
        await tx.execute(sql`
        INSERT INTO ${caseLawDecisionReviews} (
          reviewing_decision_id, reviewed_case_number, reviewed_citation_key,
          reviewed_docket_family_key, reviewed_court, reviewed_decision_date,
          reviewed_sheet_number, outcome, source, evidence_classification, opening_evidence, parser_version
        ) SELECT ${decisionId}::uuid, "reviewedCaseNumber", "reviewedCitationKey",
          "reviewedDocketFamilyKey", "reviewedCourt", "reviewedDecisionDate",
          "reviewedSheetNumber", outcome, source, "evidenceStatus", "openingEvidence", "parserVersion"
        FROM jsonb_to_recordset(${JSON.stringify(reviews)}::text::jsonb) AS incoming(
          "reviewedCaseNumber" varchar(256), "reviewedCitationKey" varchar(128),
          "reviewedDocketFamilyKey" text, "reviewedCourt" varchar(512),
          "reviewedDecisionDate" date, "reviewedSheetNumber" varchar(32),
          outcome text, source text, "evidenceStatus" text, "openingEvidence" jsonb, "parserVersion" smallint
        ) ON CONFLICT (reviewing_decision_id, reviewed_court, reviewed_case_number, (COALESCE(reviewed_decision_date, '-infinity'::date)))
        DO UPDATE SET
          reviewed_citation_key = EXCLUDED.reviewed_citation_key,
          reviewed_docket_family_key = EXCLUDED.reviewed_docket_family_key,
          reviewed_decision_date = EXCLUDED.reviewed_decision_date,
          reviewed_sheet_number = EXCLUDED.reviewed_sheet_number,
          outcome = EXCLUDED.outcome,
          source = EXCLUDED.source,
          evidence_classification = EXCLUDED.evidence_classification,
          opening_evidence = EXCLUDED.opening_evidence,
          parser_version = EXCLUDED.parser_version
        WHERE (case_law_decision_reviews.reviewed_citation_key,
          case_law_decision_reviews.reviewed_docket_family_key,
          case_law_decision_reviews.reviewed_decision_date,
          case_law_decision_reviews.reviewed_sheet_number,
          case_law_decision_reviews.outcome,
          case_law_decision_reviews.source,
          case_law_decision_reviews.evidence_classification,
          case_law_decision_reviews.opening_evidence,
          case_law_decision_reviews.parser_version)
          IS DISTINCT FROM (EXCLUDED.reviewed_citation_key,
          EXCLUDED.reviewed_docket_family_key, EXCLUDED.reviewed_decision_date,
          EXCLUDED.reviewed_sheet_number, EXCLUDED.outcome, EXCLUDED.source,
          EXCLUDED.evidence_classification, EXCLUDED.opening_evidence, EXCLUDED.parser_version)

      RETURNING 1`),
      ).length;
    }

    counts.extractionVersions += executedRows(
      await tx.execute(sql`UPDATE ${caseLawDecisions}
      SET review_extraction_version = ${CASE_LAW_REVIEW_EXTRACTION_VERSION}
      WHERE id = ${decisionId}::uuid AND country = 'CZE'
        AND review_extraction_version IS DISTINCT FROM ${CASE_LAW_REVIEW_EXTRACTION_VERSION}
      RETURNING 1`),
    ).length;
  }

  counts.resolvedReviews += executedRows(
    await tx.execute(sql`
    WITH affected AS (
      SELECT review.*
      FROM ${caseLawDecisionReviews} review
      WHERE review.reviewing_decision_id = ${decisionId}::uuid
      UNION
      SELECT review.*
      FROM ${caseLawDecisionReviews} review
      WHERE review.reviewed_decision_id = ${decisionId}::uuid
      UNION
      SELECT review.*
      FROM ${caseLawDecisionReviews} review
      INNER JOIN ${caseLawDecisions} arrived
        ON review.reviewed_court = arrived.court
        AND review.reviewed_docket_family_key = arrived.docket_family_key
      WHERE arrived.id = ${decisionId}::uuid AND arrived.country = 'CZE'
      UNION
      SELECT review.*
      FROM ${caseLawDecisionReviews} review
      WHERE ${previousIdentity?.country === "CZE"}::boolean
        AND review.reviewed_court = ${previousIdentity?.court ?? null}
        AND review.reviewed_docket_family_key = ${previousIdentity?.docketFamilyKey ?? null}
    ), resolved AS (
      SELECT review.reviewing_decision_id, review.reviewed_court,
        review.reviewed_case_number, review.reviewed_decision_date,
        CASE WHEN count(candidate.id) = 1 THEN min(candidate.id::text)::uuid END AS target
      FROM affected review
      LEFT JOIN LATERAL (
        SELECT decision.id
        FROM ${caseLawDecisions} decision
        WHERE decision.country = 'CZE'
          AND decision.court = review.reviewed_court
          AND decision.docket_family_key = review.reviewed_docket_family_key
          AND decision.id <> review.reviewing_decision_id
          AND decision.redacted_at IS NULL
          AND jsonb_extract_path_text(decision.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true'
          AND (review.reviewed_decision_date IS NULL OR decision.decision_date = review.reviewed_decision_date)
          AND (review.reviewed_sheet_number IS NULL
            OR decision.sheet_number = review.reviewed_sheet_number
            OR decision.case_number ~ ('[-‐‑‒–—−] *' || review.reviewed_sheet_number || '$')
            OR split_part(decision.ecli, '.', array_length(string_to_array(decision.ecli, '.'), 1)) = review.reviewed_sheet_number)
        ORDER BY decision.id
        LIMIT 2
      ) candidate ON true
      GROUP BY review.reviewing_decision_id, review.reviewed_court, review.reviewed_case_number, review.reviewed_decision_date
    )
    UPDATE ${caseLawDecisionReviews} review
    SET reviewed_decision_id = resolved.target
    FROM resolved
    WHERE review.reviewing_decision_id = resolved.reviewing_decision_id
      AND review.reviewed_court = resolved.reviewed_court
      AND review.reviewed_case_number = resolved.reviewed_case_number
      AND review.reviewed_decision_date IS NOT DISTINCT FROM resolved.reviewed_decision_date
      AND review.reviewed_decision_id IS DISTINCT FROM resolved.target

      RETURNING 1`),
  ).length;
  await recordSystemAudit(tx, "system:case-law-review-reconcile", {
    subject: auditSubject,
    counts,
  });
};
