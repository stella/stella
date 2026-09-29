import { and, eq, inArray, sql } from "drizzle-orm";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import type { rootDb } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  decisionBucketSql,
  decisionMonthSql,
  decisionYearSql,
} from "@/api/lib/case-law/sitemap-shard-sql";

type OldSitemapRefreshDb = Pick<typeof rootDb, "select">;

/**
 * Pre-#4072 whole-corpus count query, retained as a test fixture for query-plan
 * comparisons. This mirrors `sitemapBucketCountsQuery` at e67ad8b7d9 and has no
 * country cursor or page limit.
 */
export const oldSitemapBucketCountsQuery = (db: OldSitemapRefreshDb) =>
  db
    .select({
      country: caseLawDecisions.country,
      year: decisionYearSql.as("year"),
      month: decisionMonthSql.as("month"),
      bucket: decisionBucketSql.as("bucket"),
      total: sql<number>`count(*)::int`.as("total"),
      lastModifiedAt: sql<Date>`max(${caseLawDecisions.updatedAt})`.as(
        "last_modified_at",
      ),
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(
      and(
        redistributableCaseLawSource,
        publishedCaseLawDecision,
        inArray(caseLawDecisions.country, [...PUBLIC_CASE_LAW_COUNTRIES]),
      ),
    )
    .groupBy(
      caseLawDecisions.country,
      decisionYearSql,
      decisionMonthSql,
      decisionBucketSql,
    );
