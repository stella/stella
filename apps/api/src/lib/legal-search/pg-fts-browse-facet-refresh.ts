import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import {
  caseLawBrowseFacetCounts,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type RefreshDb = Pick<typeof rootDb, "select" | "transaction">;

/** The published input; its four fields are covered by the search-candidate index. */
export const pgFtsBrowseFacetPublishedQuery = (db: Pick<RefreshDb, "select">) =>
  db
    .select({
      sourceId: sql`${publishedCaseLawDecisions.sourceId}`.as("source_id"),
      country: sql`${publishedCaseLawDecisions.country}`.as("country"),
      court: sql`${publishedCaseLawDecisions.court}`.as("court"),
      decisionDate: sql`${publishedCaseLawDecisions.decisionDate}`.as(
        "decision_date",
      ),
    })
    .from(publishedCaseLawDecisions);

/** Recount source-scoped buckets so public reads can apply live source policy. */
export const refreshPgFtsBrowseFacets = async (
  db: RefreshDb,
  signal?: AbortSignal,
) =>
  await db.transaction(async (tx) => {
    await tx.delete(caseLawBrowseFacetCounts).where(sql`true`);
    await tx.execute(sql`
      WITH published AS MATERIALIZED (${pgFtsBrowseFacetPublishedQuery(tx)})
      INSERT INTO ${caseLawBrowseFacetCounts}
        (kind, country, source_id, value, total)
      SELECT 'country', country, source_id, country, count(*)::int
      FROM published
      GROUP BY source_id, country
      UNION ALL
      SELECT 'court', country, source_id, court, count(*)::int
      FROM published
      GROUP BY source_id, country, court
      UNION ALL
      SELECT 'year', country, source_id,
        to_char(decision_date, 'YYYY'), count(*)::int
      FROM published
      WHERE decision_date IS NOT NULL
      GROUP BY source_id, country, to_char(decision_date, 'YYYY')
    `);

    const [summary] = await tx
      .select({ buckets: sql<number>`count(*)::int` })
      .from(caseLawBrowseFacetCounts);
    if (!summary) {
      panic("Browse facet refresh aggregate returned no row.");
    }
    signal?.throwIfAborted();
    return { buckets: summary.buckets };
  });

type FacetRefreshTransaction = Parameters<
  Parameters<RefreshDb["transaction"]>[0]
>[0];

/** Discard a source's buckets before the next published-input recount. */
export const invalidatePgFtsBrowseFacetsTx = async (
  tx: FacetRefreshTransaction,
  sourceId: SafeId<"caseLawSource">,
): Promise<void> => {
  // audit: skip — snapshot invalidation belongs to the canonical removal audit.
  await tx
    .delete(caseLawBrowseFacetCounts)
    .where(eq(caseLawBrowseFacetCounts.sourceId, sourceId));
};
