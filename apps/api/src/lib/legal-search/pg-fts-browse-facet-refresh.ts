import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { caseLawBrowseFacetCounts, caseLawDecisions } from "@/api/db/schema";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";

type RefreshDb = Pick<typeof rootDb, "select" | "transaction">;

/** One refresh statement may run for at most 15 minutes; rollback keeps the old snapshot. */
const BROWSE_FACET_REFRESH_STATEMENT_TIMEOUT = "15min";

/** The published input; its four fields are covered by the search-candidate index. */
export const pgFtsBrowseFacetPublishedQuery = (db: Pick<RefreshDb, "select">) =>
  db
    .select({
      sourceId: sql`${caseLawDecisions.sourceId}`.as("source_id"),
      country: sql`${caseLawDecisions.country}`.as("country"),
      court: sql`${caseLawDecisions.court}`.as("court"),
      decisionDate: sql`${caseLawDecisions.decisionDate}`.as("decision_date"),
    })
    .from(caseLawDecisions)
    .where(publishedCaseLawDecision);

/** Recount source-scoped buckets so public reads can apply live source policy. */
export const refreshPgFtsBrowseFacets = async (db: RefreshDb) =>
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${BROWSE_FACET_REFRESH_STATEMENT_TIMEOUT}, true)`,
    );
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
    return { buckets: summary.buckets };
  });
