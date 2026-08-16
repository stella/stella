import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { courtWeightSql } from "@/api/handlers/case-law/citation-score";
import type { CourtWeightEntry } from "@/api/handlers/case-law/court-weights";
import { redistributableCaseLawSourceSqlFor } from "@/api/lib/case-law/redistribution";
import { setCorpusBackfillStatementTimeout } from "@/api/lib/legal-search/backfill-statement-timeout";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Materialize the citation-authority ranking signal onto
 * `case_law_decisions.citation_authority` (and `citation_count`).
 *
 * This is the query-independent half of the case-law ranking. It is the
 * same value the search SQL used to compute inline per query with a
 * LATERAL over the citation graph:
 *
 *   authority = ln(1 + weightedCitationSum / max(ageYears(decision), 1))
 *
 * where each incoming citation contributes
 * `courtWeight(citingCourt) * 1/(1 + ageYears(citing))`. See
 * citation-score.ts for the reference TS implementation; this SQL must
 * stay equal to `citationScore(...)` evaluated at the same instant.
 *
 * Because the value decays with time (both age terms reference "now"),
 * it is a point-in-time snapshot refreshed on a schedule — the search
 * blend tolerates being stale by up to one recompute interval. Pass a
 * fixed `now` to make the computation deterministic (used by tests to
 * assert equality against `citationScore`).
 *
 * Runs as one set-based UPDATE over the whole corpus. At pilot
 * (jurisdiction) scale this is cheap; at hundreds-of-millions scale it
 * should become incremental, keyed off `citation_authority_computed_at`
 * (the column exists for that future bound).
 *
 * Court weights are passed in via `courtWeightEntries` rather than
 * loaded internally: this keeps the function a pure `tx`-in/count-out
 * unit that is safe to exercise against a pglite fixture in tests.
 * Production callers load the current DB-seeded weights themselves
 * (`loadCourtWeightEntriesForSql()`) before calling in; omitting the
 * option falls back to `courtWeightSql`'s legacy hardcoded tiers.
 */

type CitationAuthorityTx = {
  execute: (query: SQL) => Promise<unknown>;
};

type RecomputeCitationAuthorityOptions = {
  now?: Date;
  courtWeightEntries?: CourtWeightEntry[] | undefined;
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

/**
 * Whether any citation has resolved to a target decision. Until one has, a
 * recompute scans the whole citation table to update nothing; the daemon
 * sleeps through that regime instead. Served by the partial cited-decision
 * index, so the probe is O(1).
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
 * When the last full recompute committed. The whole-corpus statement stamps
 * every cited row with the same per-statement now(), so the max is the last
 * run's time. This is a sequential scan; callers probe once per process
 * start, not per iteration.
 */
export const latestCitationAuthorityRecomputeAt = async (
  tx: CitationAuthorityTx,
): Promise<Date | null> => {
  const result = await tx.execute(
    sql`SELECT max(citation_authority_computed_at) AS latest FROM case_law_decisions`,
  );
  const row = executedRows(result).at(0);
  if (!isRecord(row)) {
    return null;
  }
  const latest = row["latest"];
  if (latest instanceof Date) {
    return latest;
  }
  if (typeof latest === "string" && latest.length > 0) {
    return new Date(latest);
  }
  return null;
};

export const recomputeCitationAuthorityForAll = async (
  tx: CitationAuthorityTx,
  options: RecomputeCitationAuthorityOptions = {},
): Promise<number> => {
  const nowExpr = options.now
    ? sql`${options.now.toISOString()}::timestamptz`
    : sql`now()`;
  // Court-authority weighting as a CASE expression over the citing
  // court name; mirrors the search SQL's `courtWeightSql`.
  const courtWeightExpr = sql.raw(
    courtWeightSql("citing_d.court", options.courtWeightEntries),
  );

  // The aggregate over (citation ⨝ citing decision) is LEFT JOINed onto
  // every decision so decisions with zero citations are reset to 0 too.
  // The inner JOIN on citing_d matches the original semantics (a
  // citation whose citing decision no longer exists does not count).
  await setCorpusBackfillStatementTimeout(tx);
  await tx.execute(sql`
    UPDATE case_law_decisions d
    SET
      citation_authority = ln(1 + (
        agg.raw_sum / GREATEST(
          COALESCE(
            extract(
              epoch FROM (
                ${nowExpr}
                - (d.decision_date::timestamp AT TIME ZONE 'UTC')
              )
            ) / ${SECONDS_PER_YEAR},
            1.0
          ),
          1.0
        )
      )),
      citation_count = agg.cnt,
      citation_authority_computed_at = ${nowExpr}
    FROM (
      SELECT
        d2.id AS decision_id,
        coalesce(sum(
          CASE WHEN c.id IS NULL THEN 0 ELSE
            (${courtWeightExpr})
            * (1.0 / (1 + COALESCE(
                extract(
                  epoch FROM (
                    ${nowExpr}
                    - (citing_d.decision_date::timestamp AT TIME ZONE 'UTC')
                  )
                )
                  / ${SECONDS_PER_YEAR},
                1.0
              )))
          END
        ), 0) AS raw_sum,
        count(c.id)::int AS cnt
      FROM case_law_decisions d2
      LEFT JOIN (
        case_law_citations c
        JOIN case_law_decisions citing_d
          ON citing_d.id = c.citing_decision_id
        JOIN case_law_sources citing_src
          ON citing_src.id = citing_d.source_id
         AND ${sql.raw(redistributableCaseLawSourceSqlFor("citing_src"))}
      ) ON c.cited_decision_id = d2.id
         -- Procedural references name the judgment under review, not an
         -- authority being invoked; counting them would rank a decision
         -- by how often it was appealed.
         AND c.kind = 'precedent'
      GROUP BY d2.id
    ) agg
    WHERE agg.decision_id = d.id
  `);

  const result: unknown = await tx.execute(
    sql`SELECT count(*)::int AS n FROM case_law_decisions WHERE citation_count > 0`,
  );
  if (!Array.isArray(result)) {
    return 0;
  }
  const firstRow: unknown = result.at(0);
  if (!isRecord(firstRow) || typeof firstRow["n"] !== "number") {
    return 0;
  }
  return firstRow["n"];
};

/**
 * Try-locked variant for periodic daemon recomputes. Overlapping
 * processes (a rolling deployment, a restart racing a still-draining
 * task) would otherwise queue duplicate whole-corpus updates behind each
 * other's row locks; the advisory try-lock lets exactly one proceed and
 * the rest return null ("another process is recomputing") instead of
 * blocking. The lock is transaction-scoped, so it releases with the tx.
 */
export const tryRecomputeCitationAuthorityForAll = async (
  tx: CitationAuthorityTx,
  options: RecomputeCitationAuthorityOptions = {},
): Promise<number | null> => {
  const lockResult: unknown = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext('case_law'), hashtext('citation_authority_recompute')) AS locked`,
  );
  const lockRow: unknown = Array.isArray(lockResult)
    ? lockResult.at(0)
    : undefined;
  if (!isRecord(lockRow) || lockRow["locked"] !== true) {
    return null;
  }
  return await recomputeCitationAuthorityForAll(tx, options);
};
