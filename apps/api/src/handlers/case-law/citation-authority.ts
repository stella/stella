/**
 * Materialize the citation-authority ranking signal onto
 * `case_law_decisions.citation_authority` (and `citation_count`).
 *
 * This is the query-independent half of the case-law ranking. It is the same
 * value the search SQL used to compute inline per query with a LATERAL over
 * the citation graph:
 *
 *   authority = ln(1 + weightedCitationSum / max(ageYears(decision), 1))
 *
 * where each incoming citation contributes
 * `courtWeight(citingCourt) * 1/(1 + ageYears(citing))`. See citation-score.ts
 * for the reference TS implementation; this SQL must stay equal to
 * `citationScore(...)` evaluated at the same instant.
 *
 * Because the value decays with time (both age terms reference "now"), it is a
 * point-in-time snapshot refreshed on a schedule — the search blend tolerates
 * being stale by up to one refresh interval. Pass a fixed `now` to make the
 * computation deterministic (used by tests to assert equality against
 * `citationScore`).
 *
 * **It runs in bounded batches, and it has to.** The whole-corpus form was one
 * UPDATE over every decision, which on a corpus of this size outruns the
 * statement timeout and rolls back: it spent the work and kept none of it,
 * every time, forever. A batch is bounded by its row count rather than by the
 * corpus, so its statement finishes whatever the corpus grows to.
 *
 * **`citation_authority_computed_at` is the whole of the bookkeeping.** A
 * sweep takes the least recently computed decisions that are older than its
 * staleness boundary; recomputing one stamps it with the current instant,
 * which puts it past the boundary and out of the set being walked. So the
 * sweep advances by doing its work, with no cursor to persist and nothing to
 * resume from: a task replaced mid-sweep picks up exactly where the last one
 * stopped because the remaining work is the only work the predicate still
 * describes. Never-computed rows sort first, which is what makes the same
 * mechanism serve the initial backfill.
 *
 * Court weights are passed in via `courtWeightEntries` rather than loaded
 * internally: this keeps the function a `tx`-in/count-out unit that is safe to
 * exercise against a pglite fixture in tests. Production callers load the
 * current DB-seeded weights themselves (`loadCourtWeightEntriesForSql()`)
 * before calling in; omitting the option falls back to `courtWeightSql`'s
 * legacy hardcoded tiers.
 */

import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { courtWeightSql } from "@/api/handlers/case-law/citation-score";
import type { CourtWeightEntry } from "@/api/handlers/case-law/court-weights";
import { redistributableCaseLawSourceSqlFor } from "@/api/lib/case-law/redistribution";
import { setCorpusBackfillStatementTimeout } from "@/api/lib/legal-search/backfill-statement-timeout";
import { isRecord } from "@/api/lib/type-guards";

type CitationAuthorityTx = {
  execute: (query: SQL) => Promise<unknown>;
};

const SECONDS_PER_YEAR = 365.25 * 86_400;

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const firstNumber = (result: unknown, key: string): number => {
  const row = executedRows(result).at(0);
  if (!isRecord(row)) {
    return 0;
  }
  const value = Number(row[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
};

/** The SQL aliases a contribution expression may read. */
export type CitationContributionAliases = {
  /** The citation row. */
  citation: string;
  /** The decision that made the citation. */
  citing: string;
};

export type CitationContributionOptions = {
  aliases: CitationContributionAliases;
  /** The instant the batch is evaluated at. */
  now: SQL;
  courtWeightEntries?: CourtWeightEntry[] | undefined;
};

/**
 * What one incoming citation adds to a decision's weighted sum.
 *
 * A seam, not an abstraction for its own sake. The ranking's open question is
 * whether a citation that distinguishes or overrules a decision should count
 * for less than one that follows it, and answering it must not mean rewriting
 * the aggregate, the batching and the equality test against `citationScore` at
 * the same time. Everything outside this expression is arithmetic that would
 * not change; a polarity multiplier is a change to this expression alone.
 *
 * No polarity term today, deliberately. `case_law_citations.polarity` is
 * populated for almost nothing, so a discount keyed on it would not express
 * "endorsements rank above criticism" — it would express "classified citations
 * rank below unclassified ones", which misranks the corpus in proportion to
 * how little of it has been classified.
 */
export type CitationContributionWeight = (
  options: CitationContributionOptions,
) => SQL;

/**
 * Court authority multiplied by a hyperbolic decay on the citing decision's
 * age. Mirrors `courtWeight(...) * recencyFactor(...)` in citation-score.ts,
 * which is the equality the tests assert.
 */
export const courtRecencyContributionWeight: CitationContributionWeight = ({
  aliases,
  courtWeightEntries,
  now,
}) =>
  sql`(${sql.raw(courtWeightSql(`${aliases.citing}.court`, courtWeightEntries))})
      * (1.0 / (1 + COALESCE(
          extract(
            epoch FROM (
              ${now} - (${sql.raw(aliases.citing)}.decision_date::timestamp AT TIME ZONE 'UTC')
            )
          ) / ${SECONDS_PER_YEAR},
          1.0
        )))`;

export type CitationAuthorityBatchOptions = {
  /** Decisions per statement. The bound the statement timeout is judged on. */
  limit: number;
  /**
   * Recompute decisions last computed before this instant, and decisions never
   * computed at all. `now` makes the batch part of a full sweep; `now` minus
   * the refresh interval makes it part of the periodic decay refresh.
   *
   * This is the whole of the sweep's state. A recomputed row is stamped with
   * the current instant and so falls out of the set, which is why a sweep
   * needs no cursor and resumes wherever it was interrupted.
   */
  staleBefore: Date;
  now?: Date;
  courtWeightEntries?: CourtWeightEntry[] | undefined;
  /** Defaults to `courtRecencyContributionWeight`. */
  contributionWeight?: CitationContributionWeight | undefined;
};

export type CitationAuthorityBatch = {
  /** Decisions the batch recomputed. Zero means the sweep is complete. */
  recomputed: number;
  /** Of those, how many hold at least one counted citation. */
  cited: number;
};

/**
 * Whether any citation has resolved to a target decision. Until one has, a
 * recompute walks the corpus to write zeroes; the daemon sleeps through that
 * regime instead. Served by the partial cited-decision index, so the probe is
 * O(1).
 */
export const hasResolvedCitations = async (
  tx: CitationAuthorityTx,
): Promise<boolean> => {
  const result = await tx.execute(
    sql`SELECT 1 AS one FROM case_law_citations WHERE cited_decision_id IS NOT NULL AND kind = 'precedent' LIMIT 1`,
  );
  return executedRows(result).length > 0;
};

/**
 * How far behind the ranking is: the oldest instant any decision was computed
 * at, or null while some decision has never been computed.
 *
 * The minimum rather than the maximum, because a sweep now advances row by row
 * instead of stamping the whole corpus at once — the freshest row says nothing
 * about the picture as a whole, and the oldest says everything. Served by the
 * computed-at index, so it is an index probe rather than a scan.
 */
export const oldestCitationAuthorityRecomputeAt = async (
  tx: CitationAuthorityTx,
): Promise<Date | null> => {
  const uncomputed = await tx.execute(
    sql`SELECT 1 AS one FROM case_law_decisions WHERE citation_authority_computed_at IS NULL LIMIT 1`,
  );
  if (executedRows(uncomputed).length > 0) {
    return null;
  }
  const result = await tx.execute(
    sql`SELECT citation_authority_computed_at AS oldest
          FROM case_law_decisions
         WHERE citation_authority_computed_at IS NOT NULL
         ORDER BY citation_authority_computed_at
         LIMIT 1`,
  );
  const row = executedRows(result).at(0);
  if (!isRecord(row)) {
    return null;
  }
  const oldest = row["oldest"];
  if (oldest instanceof Date) {
    return oldest;
  }
  if (typeof oldest === "string" && oldest.length > 0) {
    return new Date(oldest);
  }
  return null;
};

/**
 * Recompute one bounded slice of the corpus, least recently computed first.
 *
 * The aggregate keeps the shape the whole-corpus statement had, with the batch
 * as its driving side: the citation join is nested inside the LEFT JOIN so a
 * citation whose citing decision is gone, or whose source is not
 * redistributable, contributes nothing AND is not counted. Those are the same
 * row being absent, and separating them would change the count.
 *
 * Every batch row is written, including a decision with no citations at all —
 * that is what resets a decision whose last citation went away, and what makes
 * the sum over batches equal the old single statement rather than merely
 * resemble it.
 */
export const recomputeCitationAuthorityBatch = async (
  tx: CitationAuthorityTx,
  {
    contributionWeight = courtRecencyContributionWeight,
    courtWeightEntries,
    limit,
    now,
    staleBefore,
  }: CitationAuthorityBatchOptions,
): Promise<CitationAuthorityBatch> => {
  // `now()` is the transaction's start, so every row a batch writes carries
  // the same instant. It advances between batches, which is why the staleness
  // probe reads the oldest value rather than the newest.
  const nowExpr = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  const contribution = contributionWeight({
    aliases: { citation: "c", citing: "citing_d" },
    now: nowExpr,
    courtWeightEntries,
  });

  await setCorpusBackfillStatementTimeout(tx);
  const result: unknown = await tx.execute(sql`
    WITH batch AS (
      SELECT d.id, d.decision_date
        FROM case_law_decisions d
       WHERE d.citation_authority_computed_at IS NULL
          OR d.citation_authority_computed_at < ${staleBefore.toISOString()}::timestamptz
       ORDER BY d.citation_authority_computed_at ASC NULLS FIRST, d.id
       LIMIT ${limit}
    ),
    agg AS (
      SELECT b.id AS decision_id,
             b.decision_date,
             coalesce(sum(
               CASE WHEN c.id IS NULL THEN 0 ELSE ${contribution} END
             ), 0) AS raw_sum,
             count(c.id)::int AS cnt
        FROM batch b
        LEFT JOIN (
          case_law_citations c
          JOIN case_law_decisions citing_d
            ON citing_d.id = c.citing_decision_id
          JOIN case_law_sources citing_src
            ON citing_src.id = citing_d.source_id
           AND ${sql.raw(redistributableCaseLawSourceSqlFor("citing_src"))}
        ) ON c.cited_decision_id = b.id
           -- Procedural references name the judgment under review, not an
           -- authority being invoked; counting them would rank a decision by
           -- how often it was appealed.
           AND c.kind = 'precedent'
       GROUP BY b.id, b.decision_date
    ),
    updated AS (
      UPDATE case_law_decisions d
         SET citation_authority = ln(1 + (
               agg.raw_sum / GREATEST(
                 COALESCE(
                   extract(
                     epoch FROM (
                       ${nowExpr}
                       - (agg.decision_date::timestamp AT TIME ZONE 'UTC')
                     )
                   ) / ${SECONDS_PER_YEAR},
                   1.0
                 ),
                 1.0
               )
             )),
             citation_count = agg.cnt,
             citation_authority_computed_at = ${nowExpr}
        FROM agg
       WHERE agg.decision_id = d.id
      RETURNING agg.cnt AS cnt
    )
    SELECT count(*)::int AS recomputed,
           count(*) FILTER (WHERE u.cnt > 0)::int AS cited
      FROM updated u
  `);

  return {
    recomputed: firstNumber(result, "recomputed"),
    cited: firstNumber(result, "cited"),
  };
};

/**
 * Take one batch, or report that another writer holds the sweep.
 *
 * The lock is transaction-scoped and therefore per batch, which is the point:
 * two processes cannot write the same slice at once, and neither holds the
 * sweep across a whole corpus. A rolling deployment costs one batch's
 * contention rather than an hour of progress.
 */
export const tryRecomputeCitationAuthorityBatch = async (
  tx: CitationAuthorityTx,
  options: CitationAuthorityBatchOptions,
): Promise<CitationAuthorityBatch | null> => {
  const lockResult: unknown = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext('case_law'), hashtext('citation_authority_recompute')) AS locked`,
  );
  const lockRow = executedRows(lockResult).at(0);
  if (!isRecord(lockRow) || lockRow["locked"] !== true) {
    return null;
  }
  return await recomputeCitationAuthorityBatch(tx, options);
};
