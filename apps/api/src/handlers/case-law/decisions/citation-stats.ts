import { panic } from "better-result";
import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawDecisionCitationStatsState,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { boundedAll } from "@/api/lib/db/bounded-all";
import { logger } from "@/api/lib/observability/logger";

/** Plane paces each transaction; a batch cannot grow with corpus size. */
export const DECISION_CITATION_STATS_BATCH_MAX = 32;

type CitationStatsTransaction = Pick<Transaction, "select"> & {
  execute: (query: SQL) => PromiseLike<unknown>;
};
type CitationStatsOptions = {
  tx: CitationStatsTransaction;
  decisionIds: readonly SafeId<"caseLawDecision">[];
};

const validateBatch = (decisionIds: CitationStatsOptions["decisionIds"]) => {
  if (decisionIds.length > DECISION_CITATION_STATS_BATCH_MAX) {
    panic("Decision citation stats batch exceeds its bound");
  }
};

/** Lock before comparing so a concurrent writer cannot create false drift. */
const lockStatsBatch = async ({ tx, decisionIds }: CitationStatsOptions) => {
  await tx.execute(sql`
    SELECT id FROM case_law_decisions
    WHERE id IN (${sql.join(
      decisionIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) ORDER BY id FOR NO KEY UPDATE
  `);
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(19053, key) FROM (
      SELECT DISTINCT (hashtextextended('decision-citation-stats:' || id::text, 0) & 127)::integer AS key
      FROM case_law_decisions WHERE id IN (${sql.join(
        decisionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY key
    ) anchors
  `);
};

/** Recount and compare only: absence of a completed projection is a typed pending result. */
export const compareDecisionCitationStats = async ({
  tx,
  decisionIds,
}: CitationStatsOptions) => {
  validateBatch(decisionIds);
  if (decisionIds.length === 0) {
    return [];
  }
  await lockStatsBatch({ tx, decisionIds });
  const decision = caseLawDecisions;
  const state = caseLawDecisionCitationStatsState;
  const rows = await boundedAll({
    invariant: "validated decision ID batch and decision primary key",
    max: DECISION_CITATION_STATS_BATCH_MAX,
    table: "case_law_decisions",
    query: (limit) =>
      tx
        .select({
          decisionId: decision.id,
          projectionStatus: state.status,
          mismatchedBuckets: sql<number>`CASE WHEN ${state.status} = 'exact' THEN (
      WITH expected AS MATERIALIZED (SELECT * FROM recount_decision_citation_stats(${decision.id})),
      actual AS MATERIALIZED (SELECT * FROM case_law_decision_citation_stats WHERE decision_id = ${decision.id}),
      differences AS (
        (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      ) SELECT count(*)::integer FROM differences
    ) ELSE 0 END`,
        })
        .from(decision)
        .leftJoin(state, eq(state.decisionId, decision.id))
        .where(inArray(decision.id, [...decisionIds]))
        .orderBy(asc(decision.id))
        .limit(limit),
  });
  const rowsById = new Map(rows.map((row) => [row.decisionId, row]));
  return [...new Set(decisionIds)].map((decisionId) => {
    const row = rowsById.get(decisionId);
    if (row === undefined) {
      return { status: "deleted" as const, decisionId };
    }
    switch (row.projectionStatus) {
      case null:
      case "pending":
        return { status: "pending" as const, decisionId };
      case "exact":
        return row.mismatchedBuckets === 0
          ? { status: "consistent" as const, decisionId }
          : {
              status: "drift" as const,
              decisionId,
              mismatchedBuckets: row.mismatchedBuckets,
            };
      default: {
        row.projectionStatus satisfies never;
        return panic(
          `Unhandled citation stats status: ${String(row.projectionStatus)}`,
        );
      }
    }
  });
};

/** Initial online backfill and explicit repairs share the same atomic rebuild. */
export const refreshDecisionCitationStats = async ({
  tx,
  decisionIds,
}: CitationStatsOptions) => {
  validateBatch(decisionIds);
  if (decisionIds.length === 0) {
    return;
  }
  await lockStatsBatch({ tx, decisionIds });
  await tx.execute(sql`
    SELECT refresh_decision_citation_stats(id) FROM case_law_decisions
    WHERE id IN (${sql.join(
      decisionIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) ORDER BY id
  `);
};

type ReconcileCitationStatsOptions = CitationStatsOptions & {
  mode: "compare" | "repair";
};

/** The caller supplies one transaction; repairs always report the observed drift first. */
export const reconcileDecisionCitationStats = async ({
  tx,
  decisionIds,
  mode,
}: ReconcileCitationStatsOptions) => {
  const results = await compareDecisionCitationStats({ tx, decisionIds });
  const drifted = results.filter((result) => result.status === "drift");
  for (const result of drifted) {
    logger.error("case_law.citation_stats.drift", {
      decisionId: result.decisionId,
      mismatchedBuckets: result.mismatchedBuckets,
      mode,
    });
  }
  if (mode === "repair") {
    await refreshDecisionCitationStats({
      tx,
      decisionIds: drifted.map(({ decisionId }) => decisionId),
    });
  }
  return results;
};
