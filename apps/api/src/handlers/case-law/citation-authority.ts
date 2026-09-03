/**
 * Materialize the citation-authority ranking signal onto
 * `case_law_decisions.citation_authority` (and `citation_count`).
 *
 * This is the query-independent half of the case-law ranking. It is the same
 * value the search SQL used to compute inline per query with a LATERAL over
 * the citation graph:
 *
 *   authority = ln(1 + weightedCitationSum)
 *
 * where each incoming citation contributes
 * `polarityWeight(polarity) * courtWeight(citingCourt) * 1/(1 + ageYears(citing))`.
 * See citation-score.ts for the reference TS implementation; this SQL must
 * stay equal to `citationScore(...)` evaluated at the same instant.
 *
 * Because the value decays with time (the citing decision's age references
 * "now"), it is a point-in-time snapshot refreshed on a schedule — the search
 * blend tolerates being stale by up to one refresh interval. Pass a fixed
 * `now` to make the computation deterministic (used by tests to assert
 * equality against `citationScore`).
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
 * current DB-seeded weights with `loadCitationCourtWeightEntries()` below
 * before calling in; there is no built-in list behind them, so an unseeded
 * registry weighs every citing court at the default.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  courtWeightSql,
  polarityWeightSql,
} from "@/api/handlers/case-law/citation-score";
import {
  flattenCourtWeightEntries,
  loadCourtWeights,
} from "@/api/lib/case-law/court-weights";
import type { CourtWeightEntry } from "@/api/lib/case-law/court-weights";
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

/**
 * The weights a production caller passes as `courtWeightEntries`. Flattened
 * across every jurisdiction rather than scoped to one, because the *citing*
 * court decides the contribution and citation graphs cross borders.
 *
 * It lives here, with the option it satisfies, so a caller does not have to
 * reach into the registry to answer a question only this module asks.
 */
export const loadCitationCourtWeightEntries = async (): Promise<
  CourtWeightEntry[]
> => flattenCourtWeightEntries(await loadCourtWeights());

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
  courtWeightEntries: readonly CourtWeightEntry[];
};

/**
 * What one incoming citation adds to a decision's weighted sum.
 *
 * A seam, not an abstraction for its own sake: the polarity term below landed
 * as a change to this expression alone, leaving the aggregate, the batching
 * and the equality test against `citationScore` untouched.
 *
 * The polarity weighting is binary for the reason a graded one was rejected.
 * `case_law_citations.polarity` is populated for almost nothing, so any scheme
 * that moved unclassified citations off full weight would express "classified
 * citations rank below unclassified ones" rather than "endorsements rank above
 * criticism". Zeroing negative treatments alone leaves every unclassified
 * citation exactly where it was.
 */
export type CitationContributionWeight = (
  options: CitationContributionOptions,
) => SQL;

/**
 * Polarity, court authority, and a hyperbolic decay on the citing decision's
 * age. Mirrors `polarityWeight(...) * courtWeight(...) * recencyFactor(...)`
 * in citation-score.ts, which is the equality the tests assert.
 */
export const citationContributionWeight: CitationContributionWeight = ({
  aliases,
  courtWeightEntries,
  now,
}) =>
  sql`(${sql.raw(polarityWeightSql(`${aliases.citation}.polarity`))})
      * (${sql.raw(courtWeightSql(`${aliases.citing}.court`, courtWeightEntries))})
      * (1.0 / (1 + COALESCE(
          extract(
            epoch FROM (
              ${now} - (${sql.raw(aliases.citing)}.decision_date::timestamp AT TIME ZONE 'UTC')
            )
          ) / ${SECONDS_PER_YEAR},
          1.0
        )))`;

/**
 * Which decisions a batch considers stale, and what it stamps them with.
 *
 * The two are one decision, not two, which is why they are one type. The
 * predicate compares `citation_authority_computed_at` against a boundary and
 * the update writes a new value into that same column, so if the two instants
 * come from different clocks the sweep can fail to converge: a boundary from a
 * host running even milliseconds ahead of PostgreSQL leaves every row it just
 * stamped still older than the boundary, and the walk rewrites the same oldest
 * rows forever. Each variant below derives both instants from one clock.
 */
export type CitationAuthoritySweepWindow =
  /**
   * A sweep pinned to one instant: recompute every decision last computed
   * *before* it, and stamp what it recomputes with it.
   *
   * What it guarantees is a floor, not an equality — when it completes, no
   * decision was last computed before the pinned instant. A row the rolling
   * loop computed after it is already fresher and is deliberately left alone;
   * chasing exact equality instead would make the two sweeps overwrite each
   * other's stamps indefinitely whenever a pinned run outlives the refresh
   * interval. The floor is the property a backfill needs: nothing left stale.
   *
   * Restart-safe by construction — a resumed run given the same instant skips
   * precisely what the interrupted one finished, because those rows are no
   * longer before the boundary. Give a new instant and the sweep starts over,
   * which is what makes "recompute the whole corpus" expressible at all.
   *
   * Every batch of one pinned run evaluates the decay at the same instant, so
   * a run left to itself ranks its first decision and its last on identical
   * terms; a concurrent rolling loop is the exception, and it is one this
   * signal already tolerates, since it is a point-in-time approximation
   * refreshed continuously rather than a single consistent snapshot.
   */
  | { type: "pinned"; at: Date }
  /**
   * A rolling refresh: recompute whatever PostgreSQL's own clock says was last
   * computed longer ago than this. Both the boundary and the stamp come from
   * the database, so no host clock participates.
   */
  | { type: "olderThan"; ms: number };

export type CitationAuthorityBatchOptions = {
  /** Decisions per statement. The bound the statement timeout is judged on. */
  limit: number;
  /**
   * The staleness window. This is the whole of the sweep's state: a recomputed
   * row is stamped out of the set it was selected from, which is why a sweep
   * needs no cursor and resumes wherever it was interrupted.
   */
  window: CitationAuthoritySweepWindow;
  courtWeightEntries: readonly CourtWeightEntry[];
  /** Defaults to `citationContributionWeight`. */
  contributionWeight?: CitationContributionWeight | undefined;
};

/**
 * The boundary and the stamp, from one clock.
 *
 * Both are returned as SQL rather than as values, because in the rolling case
 * neither exists outside the database. The comparison site casts the boundary
 * to `timestamptz` explicitly: a bare interpolation would be a JS `Date`
 * round-tripped through millisecond precision against a microsecond column,
 * which is the class of comparison that silently re-admits or skips the
 * boundary row.
 */
const sweepInstants = (
  window: CitationAuthoritySweepWindow,
): { staleBefore: SQL; now: SQL } => {
  switch (window.type) {
    case "pinned": {
      const at = sql`${window.at.toISOString()}::timestamptz`;
      return { staleBefore: at, now: at };
    }
    case "olderThan":
      return {
        staleBefore: sql`(now() - make_interval(secs => ${window.ms / 1000}))`,
        now: sql`now()`,
      };
    default: {
      const unhandled: never = window;
      return panic(`Unhandled sweep window: ${JSON.stringify(unhandled)}`);
    }
  }
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
    contributionWeight = citationContributionWeight,
    courtWeightEntries,
    limit,
    window,
  }: CitationAuthorityBatchOptions,
): Promise<CitationAuthorityBatch> => {
  const { staleBefore, now: nowExpr } = sweepInstants(window);
  const contribution = contributionWeight({
    aliases: { citation: "c", citing: "citing_d" },
    now: nowExpr,
    courtWeightEntries,
  });

  await setCorpusBackfillStatementTimeout(tx);
  const result: unknown = await tx.execute(sql`
    WITH batch AS (
      SELECT d.id
        FROM case_law_decisions d
       WHERE d.citation_authority_computed_at IS NULL
          OR d.citation_authority_computed_at < ${staleBefore}::timestamptz
       ORDER BY d.citation_authority_computed_at ASC NULLS FIRST, d.id
       LIMIT ${limit}
    ),
    agg AS (
      SELECT b.id AS decision_id,
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
       GROUP BY b.id
    ),
    updated AS (
      UPDATE case_law_decisions d
         SET citation_authority = ln(1 + agg.raw_sum),
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
