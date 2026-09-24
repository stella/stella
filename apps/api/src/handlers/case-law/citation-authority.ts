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
 * every time, forever. A batch is a keyset slice of the primary key, so its
 * statement finishes whatever the corpus grows to.
 *
 * **A pass writes only what moved.** Most decisions are cited by nothing and
 * hold the zeroes a recompute would write again, and a cited one decays by a
 * sliver per pass. A row is written when its count changed or its value moved
 * by more than `CITATION_AUTHORITY_WRITE_TOLERANCE`; anything else would
 * rewrite the row, and every index on it, to say what it already says. For
 * the same reason nothing is stamped on the row: the sweep's position lives
 * in `case_law_citation_authority_sweep`, not on the decisions it visits.
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

import { caseLawCitationAuthoritySweep } from "@/api/db/schema";
import { CITATION_AUTHORITY_SWEEP_SCOPE } from "@/api/handlers/case-law/citation-authority-sweep-scope";
import {
  courtWeightSql,
  polarityWeightSql,
} from "@/api/handlers/case-law/citation-score";
import {
  flattenCourtWeightEntries,
  loadCourtWeights,
} from "@/api/lib/case-law/court-weights";
import type { CourtWeightEntry } from "@/api/lib/case-law/court-weights";
import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";
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
 * How far a stored value may sit from the recomputed one before the row is
 * rewritten, on the `ln(1 + sum)` scale: a thousandth of a log unit is a 0.1%
 * change in the weighted sum. A changed count is always written.
 *
 * The bound is what keeps decay from rewriting every cited decision on every
 * pass. Decay moves a value continuously, so without it a pass would always
 * find a difference in the last bits; with it a value is rewritten once its
 * drift is large enough to matter to a ranking that is already allowed to be
 * one refresh stale.
 */
export const CITATION_AUTHORITY_WRITE_TOLERANCE = 1e-3;

/**
 * The instant a batch evaluates decay at.
 *
 * `database` reads PostgreSQL's clock, which is what the continuous sweep
 * wants. `pinned` fixes it, so every batch of an operator's pass ranks its
 * first decision and its last on identical terms, and a test can compare
 * against `citationScore` at the same instant.
 */
export type CitationAuthorityInstant =
  | { type: "database" }
  | { type: "pinned"; at: Date };

const instantSql = (instant: CitationAuthorityInstant): SQL => {
  switch (instant.type) {
    case "database":
      return sql`now()`;
    case "pinned":
      return sql`${instant.at.toISOString()}::timestamptz`;
    default: {
      instant satisfies never;
      return panic(`Unhandled sweep instant: ${JSON.stringify(instant)}`);
    }
  }
};

export type CitationAuthorityBatchOptions = {
  /** Keyset position: the last decision id already examined, or null. */
  after: string | null;
  /** Decisions per statement. The bound the statement timeout is judged on. */
  limit: number;
  now: CitationAuthorityInstant;
  courtWeightEntries: readonly CourtWeightEntry[];
  /** Defaults to `citationContributionWeight`. */
  contributionWeight?: CitationContributionWeight | undefined;
};

export type CitationAuthorityBatch = {
  /** Decisions the batch examined; fewer than `limit` ends the pass. */
  scanned: number;
  /** Of those, how many were rewritten because their value moved. */
  written: number;
  /** Of those examined, how many hold at least one counted citation. */
  cited: number;
  /** The last decision examined: the next batch's `after`. */
  lastId: string | null;
};

/**
 * Whether any citation has resolved to a target decision. Until one has, a
 * recompute walks the corpus to find nothing to write; the daemon sleeps
 * through that regime instead. Served by the partial cited-decision index, so
 * the probe is O(1).
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
 * Recompute the next keyset slice of the corpus, writing only what moved.
 *
 * The aggregate keeps the shape the whole-corpus statement had, with the batch
 * as its driving side: the citation join is nested inside the LEFT JOIN so a
 * citation whose citing decision is gone, or whose source is not
 * redistributable, contributes nothing AND is not counted. Those are the same
 * row being absent, and separating them would change the count.
 *
 * Every batch row is compared, including a decision with no citations at all:
 * that is what resets a decision whose last citation went away. The write
 * guard reads the row as it stands at the write, not as the batch read it.
 *
 * The citing side carries the same two public gates as the search lateral that
 * scores a page live: a decision the corpus does not publish does not weigh on
 * one it does. A listing-only citing row that is later enriched re-enters the
 * count when the sweep next reaches its targets.
 */
export const recomputeCitationAuthorityBatch = async (
  tx: CitationAuthorityTx,
  {
    after,
    contributionWeight = citationContributionWeight,
    courtWeightEntries,
    limit,
    now,
  }: CitationAuthorityBatchOptions,
): Promise<CitationAuthorityBatch> => {
  // audit: skip — recomputes derived public case-law citation authority
  const contribution = contributionWeight({
    aliases: { citation: "c", citing: "citing_d" },
    now: instantSql(now),
    courtWeightEntries,
  });
  // Omitted rather than bound as `$1 IS NULL OR ...`: an OR on a parameter is
  // not an index condition, and the first batch would filter from the start
  // of the primary key instead of ranging over it.
  const afterClause = after === null ? sql`` : sql`WHERE d.id > ${after}::uuid`;

  await setCorpusBackfillStatementTimeout(tx);
  const result: unknown = await tx.execute(sql`
    WITH batch AS (
      SELECT d.id
        FROM case_law_decisions d
       ${afterClause}
       ORDER BY d.id
       LIMIT ${limit}
    ),
    agg AS (
      SELECT b.id AS decision_id,
             ln(1 + coalesce(sum(
               CASE WHEN c.id IS NULL THEN 0 ELSE ${contribution} END
             ), 0)) AS authority,
             count(c.id)::int AS cnt
        FROM batch b
        LEFT JOIN (
          case_law_citations c
          JOIN case_law_decisions citing_d
            ON citing_d.id = c.citing_decision_id
          JOIN case_law_sources citing_src
            ON citing_src.id = citing_d.source_id
           AND ${sql.raw(redistributableCaseLawSourceSqlFor("citing_src"))}
           AND ${sql.raw(publishedCaseLawDecisionSqlFor("citing_d"))}
        ) ON c.cited_decision_id = b.id
           -- Procedural references name the judgment under review, not an
           -- authority being invoked; counting them would rank a decision by
           -- how often it was appealed.
           AND c.kind = 'precedent'
       GROUP BY b.id
    ),
    updated AS (
      UPDATE case_law_decisions d
         SET citation_authority = agg.authority,
             citation_count = agg.cnt
        FROM agg
       WHERE agg.decision_id = d.id
         AND (
               d.citation_count IS DISTINCT FROM agg.cnt
            OR abs(d.citation_authority - agg.authority)
                 > ${CITATION_AUTHORITY_WRITE_TOLERANCE}::double precision
         )
      RETURNING d.id
    )
    SELECT (SELECT count(*) FROM batch)::int AS scanned,
           (SELECT count(*) FROM updated)::int AS written,
           (SELECT count(*) FROM agg WHERE agg.cnt > 0)::int AS cited,
           (SELECT b.id::text FROM batch b ORDER BY b.id DESC LIMIT 1)
             AS last_id
  `);

  const row = executedRows(result).at(0);
  const lastId = isRecord(row) ? row["last_id"] : null;
  return {
    scanned: firstNumber(result, "scanned"),
    written: firstNumber(result, "written"),
    cited: firstNumber(result, "cited"),
    lastId: typeof lastId === "string" && lastId.length > 0 ? lastId : null,
  };
};

export type CitationAuthoritySweepOptions = {
  /** Decisions per batch. */
  limit: number;
  /** How long after a pass began the next one is due. */
  intervalMs: number;
  courtWeightEntries: readonly CourtWeightEntry[];
};

export type CitationAuthoritySweepStep =
  /** The last pass began less than an interval ago and has finished. */
  | { type: "current" }
  | {
      type: "advanced";
      batch: CitationAuthorityBatch;
      /** This batch reached the end of the corpus, closing the pass. */
      passComplete: boolean;
    };

type SweepPosition = {
  cursor: string | null;
  /** Whether a new pass may start: the last one began an interval ago. */
  due: boolean;
};

const readSweepPosition = async (
  tx: CitationAuthorityTx,
  intervalMs: number,
): Promise<SweepPosition> => {
  // Due is decided by PostgreSQL's clock, which also stamps the pass start,
  // so a host clock running ahead cannot start passes back to back.
  const result: unknown = await tx.execute(sql`
    SELECT cursor_decision_id::text AS cursor,
           (pass_started_at IS NULL
             OR pass_started_at <= now() - make_interval(secs => ${intervalMs / 1000}))
             AS due
      FROM ${caseLawCitationAuthoritySweep}
     WHERE scope = ${CITATION_AUTHORITY_SWEEP_SCOPE.GLOBAL}
  `);
  const row = executedRows(result).at(0);
  if (!isRecord(row)) {
    return { cursor: null, due: true };
  }
  const cursor = row["cursor"];
  return {
    cursor: typeof cursor === "string" && cursor.length > 0 ? cursor : null,
    due: row["due"] === true,
  };
};

const writeSweepPosition = async (
  tx: CitationAuthorityTx,
  { cursor, passStarted }: { cursor: string | null; passStarted: boolean },
): Promise<void> => {
  // audit: skip — background ranking bookkeeping, not a user action
  await tx.execute(sql`
    INSERT INTO ${caseLawCitationAuthoritySweep}
      (scope, cursor_decision_id, pass_started_at, updated_at)
    VALUES (
      ${CITATION_AUTHORITY_SWEEP_SCOPE.GLOBAL},
      ${cursor}::uuid,
      now(),
      now()
    )
    ON CONFLICT (scope) DO UPDATE
      SET cursor_decision_id = EXCLUDED.cursor_decision_id,
          pass_started_at = ${
            passStarted
              ? sql`EXCLUDED.pass_started_at`
              : sql`${caseLawCitationAuthoritySweep.passStartedAt}`
          },
          updated_at = EXCLUDED.updated_at
  `);
};

/**
 * Advance the continuous sweep by one batch, or report that another writer
 * holds it.
 *
 * The lock, the position read, the batch and the position write are one
 * transaction, so two replicas cannot persist positions out of order, and a
 * batch whose writes roll back takes its position with it. The lock is
 * transaction-scoped and therefore per batch: a rolling deployment costs one
 * batch's contention rather than a pass.
 *
 * A pass starts from the beginning of the corpus once the last one began an
 * interval ago, and ends on the batch that comes back short. Between passes
 * the step reports `current` and writes nothing.
 */
export const tryAdvanceCitationAuthoritySweep = async (
  tx: CitationAuthorityTx,
  { courtWeightEntries, intervalMs, limit }: CitationAuthoritySweepOptions,
): Promise<CitationAuthoritySweepStep | null> => {
  const lockResult: unknown = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext('case_law'), hashtext('citation_authority_recompute')) AS locked`,
  );
  const lockRow = executedRows(lockResult).at(0);
  if (!isRecord(lockRow) || lockRow["locked"] !== true) {
    return null;
  }
  const position = await readSweepPosition(tx, intervalMs);
  const passStarted = position.cursor === null;
  if (passStarted && !position.due) {
    return { type: "current" };
  }
  const batch = await recomputeCitationAuthorityBatch(tx, {
    after: position.cursor,
    limit,
    now: { type: "database" },
    courtWeightEntries,
  });
  const passComplete = batch.scanned < limit;
  await writeSweepPosition(tx, {
    cursor: passComplete ? null : batch.lastId,
    passStarted,
  });
  return { type: "advanced", batch, passComplete };
};
