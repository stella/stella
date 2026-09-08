/**
 * The database side of the three decision-analysis operator scripts: one
 * connection, and the two reads they share.
 *
 * The connection comes from `CASE_LAW_ANALYSIS_DATABASE_URL` rather than
 * the application's own, because these scripts are meant to run as
 * `stella_case_law_analysis_writer`: SELECT on the columns below and UPDATE on
 * `case_law_decisions.analysis`, nothing else. Every statement here is
 * written against exactly that grant, so a run that reaches for anything
 * more fails loudly instead of silently needing a wider login.
 */

import { SQL } from "bun";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL as SqlFragment } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { publisherSummaryMetadataSql } from "@/api/lib/case-law/publisher-summary";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";

import type { DecisionAnalysisRow } from "./decision-analysis.logic";

/** Small pool: these scripts run one decision at a time under an operator. */
const POOL_SIZE = 4;

export type AnalysisDatabase = ReturnType<typeof openAnalysisDatabase>;

export const openAnalysisDatabase = (url: string) =>
  drizzle({
    client: new SQL({ url, max: POOL_SIZE }),
    relations: databaseRelations,
  });

const decisionColumns = {
  id: caseLawDecisions.id,
  language: caseLawDecisions.language,
  court: caseLawDecisions.court,
  country: caseLawDecisions.country,
  decisionType: caseLawDecisions.decisionType,
  documentAst: caseLawDecisions.documentAst,
  astS3Key: caseLawDecisions.astS3Key,
  contentHash: caseLawDecisions.contentHash,
  analysis: caseLawDecisions.analysis,
  redactedAt: caseLawDecisions.redactedAt,
  sourceRowId: caseLawSources.id,
  descriptor: caseLawSources.descriptor,
} as const;

type DecisionSelection = {
  id: SafeId<"caseLawDecision">;
  language: string;
  court: string;
  country: string;
  decisionType: string | null;
  documentAst: unknown;
  astS3Key: string | null;
  contentHash: string | null;
  analysis: unknown;
  redactedAt: Date | null;
  sourceRowId: SafeId<"caseLawSource"> | null;
  descriptor: CorpusSourceDescriptor | null;
};

/**
 * A missing source row and a source whose descriptor is null are different
 * answers: the first is a decision whose reuse terms are unknown, which is
 * refused, while the second is a legacy source the descriptor field
 * predates. The join's own id is what separates them.
 */
const sourceOf = (row: DecisionSelection): DecisionAnalysisRow["source"] =>
  row.sourceRowId === null ? null : { descriptor: row.descriptor };

const toRow = (row: DecisionSelection): DecisionAnalysisRow => ({
  id: row.id,
  language: row.language,
  court: row.court,
  country: row.country,
  decisionType: row.decisionType,
  documentAst: row.documentAst,
  astS3Key: row.astS3Key,
  contentHash: row.contentHash,
  analysis: row.analysis,
  redactedAt: row.redactedAt,
  source: sourceOf(row),
});

/**
 * Every named decision in one statement, by id. A left join on the source,
 * so a decision whose source row is missing comes back and is refused for
 * its terms rather than vanishing as "not found"; an id with no row is
 * simply absent from the map, which is what the caller reports.
 */
export const readDecisionRows = async (
  db: AnalysisDatabase,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<Map<string, DecisionAnalysisRow>> => {
  if (decisionIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select(decisionColumns)
    .from(caseLawDecisions)
    .leftJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(inArray(caseLawDecisions.id, [...decisionIds]));
  return new Map(rows.map((row) => [row.id, toRow(row)]));
};

export type CandidateRow = {
  id: SafeId<"caseLawDecision">;
  court: string;
  country: string;
  citationCount: number;
  citationAuthority: number | null;
  /** A publisher's own headnote on the row: the only reporting signal stored. */
  reportedInCollection: boolean;
  /** The stored analysis, to tell a current version 3 row from a stale one. */
  analysis: unknown;
  language: string;
  decisionType: string | null;
  documentAst: unknown;
  astS3Key: string | null;
  contentHash: string | null;
  redactedAt: Date | null;
  source: DecisionAnalysisRow["source"];
};

/**
 * Where the previous page stopped: the ordering key of its last row. The
 * next page resumes strictly after it, so a run that keeps excluding rows
 * keeps descending the ranking instead of running out of scan window.
 */
export type CandidateCursor = {
  citationAuthority: number | null;
  citationCount: number;
  id: SafeId<"caseLawDecision">;
};

type ListCandidatesOptions = {
  country?: string | undefined;
  minCitations: number;
  /** Rows to read in this page. */
  scan: number;
  /** Resume strictly after this row; absent for the first page. */
  after?: CandidateCursor | undefined;
};

/**
 * Decisions worth analysing first, most-cited first.
 *
 * `citation_authority` is the stored importance signal: a decay-weighted sum
 * over incoming citations that already folds in the citing courts' weights
 * and each citation's polarity, so ordering by it is ordering by how much
 * later case law leans on the decision. Court tier and the publisher
 * headnote are reported beside it rather than mixed into it, because they
 * answer a different question and an operator picking a batch wants to see
 * them.
 */
export const listCandidateRows = async (
  db: AnalysisDatabase,
  { after, country, minCitations, scan }: ListCandidatesOptions,
): Promise<CandidateRow[]> => {
  const filters: SqlFragment[] = [
    isNull(caseLawDecisions.redactedAt),
    sql`${caseLawDecisions.citationCount} >= ${minCitations}`,
  ];
  if (country !== undefined) {
    filters.push(eq(caseLawDecisions.country, country));
  }
  if (after !== undefined) {
    // The ordering key as one tuple comparison. `NULLS LAST` on the leading
    // term means an unscored row sorts after every scored one, so the
    // cursor's null case resumes inside the unscored tail by (count, id).
    const authority = after.citationAuthority;
    filters.push(
      authority === null
        ? sql`(${caseLawDecisions.citationAuthority} IS NULL
              AND (${caseLawDecisions.citationCount}, ${caseLawDecisions.id})
                  < (${after.citationCount}, ${after.id}))`
        : sql`(${caseLawDecisions.citationAuthority} IS NULL
              OR (${caseLawDecisions.citationAuthority}, ${caseLawDecisions.citationCount}, ${caseLawDecisions.id})
                 < (${authority}, ${after.citationCount}, ${after.id}))`,
    );
  }

  const rows = await db
    .select({
      ...decisionColumns,
      citationCount: caseLawDecisions.citationCount,
      citationAuthority: caseLawDecisions.citationAuthority,
      publisherSummary: publisherSummaryMetadataSql(caseLawDecisions.metadata),
    })
    .from(caseLawDecisions)
    .leftJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(and(...filters))
    // `NULLS LAST` explicitly: Postgres puts nulls FIRST under `DESC`, so an
    // unscored decision would otherwise outrank every scored one and a
    // bounded scan would never reach the top of the ranking.
    .orderBy(
      sql`${caseLawDecisions.citationAuthority} DESC NULLS LAST`,
      desc(caseLawDecisions.citationCount),
      caseLawDecisions.id,
    )
    .limit(scan);

  return rows.map((row) => ({
    id: row.id,
    court: row.court,
    country: row.country,
    citationCount: row.citationCount,
    citationAuthority: row.citationAuthority,
    reportedInCollection: row.publisherSummary !== null,
    analysis: row.analysis,
    language: row.language,
    decisionType: row.decisionType,
    documentAst: row.documentAst,
    astS3Key: row.astS3Key,
    contentHash: row.contentHash,
    redactedAt: row.redactedAt,
    source: sourceOf(row),
  }));
};

export const candidateAsRow = (row: CandidateRow): DecisionAnalysisRow => ({
  id: row.id,
  language: row.language,
  court: row.court,
  country: row.country,
  decisionType: row.decisionType,
  documentAst: row.documentAst,
  astS3Key: row.astS3Key,
  contentHash: row.contentHash,
  analysis: row.analysis,
  redactedAt: row.redactedAt,
  source: row.source,
});
