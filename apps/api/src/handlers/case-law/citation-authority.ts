import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { courtWeightSql } from "@/api/handlers/case-law/citation-score";

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
 */

type CitationAuthorityTx = {
  execute: (query: SQL) => Promise<unknown>;
};

const SECONDS_PER_YEAR = 365.25 * 86_400;

export const recomputeCitationAuthorityForAll = async (
  tx: CitationAuthorityTx,
  options: { now?: Date } = {},
): Promise<number> => {
  const nowExpr = options.now
    ? sql`${options.now.toISOString()}::timestamptz`
    : sql`now()`;
  // Court-authority weighting as a CASE expression over the citing
  // court name; mirrors the search SQL's `courtWeightSql`.
  const courtWeightExpr = sql.raw(courtWeightSql("citing_d.court"));

  // The aggregate over (citation ⨝ citing decision) is LEFT JOINed onto
  // every decision so decisions with zero citations are reset to 0 too.
  // The inner JOIN on citing_d matches the original semantics (a
  // citation whose citing decision no longer exists does not count).
  await tx.execute(sql`SET LOCAL statement_timeout = '15min'`);
  await tx.execute(sql`
    UPDATE case_law_decisions d
    SET
      citation_authority = ln(1 + (
        agg.raw_sum / GREATEST(
          COALESCE(
            extract(epoch FROM (${nowExpr} - d.decision_date)) / ${SECONDS_PER_YEAR},
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
                extract(epoch FROM (${nowExpr} - citing_d.decision_date))
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
      ) ON c.cited_decision_id = d2.id
      GROUP BY d2.id
    ) agg
    WHERE agg.decision_id = d.id
  `);

  const result: unknown = await tx.execute(
    sql`SELECT count(*)::int AS n FROM case_law_decisions WHERE citation_count > 0`,
  );
  // SAFETY: `count(*)::int AS n` yields one row whose `n` is an integer;
  // the driver may return the rows bare or wrapped, so guard for an array.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- known count() result shape
  const rows = Array.isArray(result) ? (result as { n: number }[]) : [];
  return Number(rows.at(0)?.n) || 0;
};
