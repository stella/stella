import { sql } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import { publishedUnredactedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions-sql";
import { redistributableCaseLawSourceSqlFor } from "@/api/lib/case-law/redistribution-sql";
import { groupableSql } from "@/api/lib/groupable-sql";

/**
 * How the public case-law sitemap names its shards: a country's month, or its
 * undated decisions, and a split month's hashed buckets. Shared by the refresh
 * that lists the shards and the shard read that serves one.
 */
const SITEMAP_SHARD_BUCKET_COUNT = 64;
const SITEMAP_SHARD_BUCKET_WIDTH = 2;
export const SITEMAP_UNDATED_YEAR = "undated";
export const SITEMAP_UNDATED_MONTH = "00";
export const SITEMAP_ALL_BUCKET = "all";

/**
 * One stable eligible row per document, chosen across all dates and buckets.
 * Filtering a shard's rows afterwards would repeat documents whose language
 * versions have different ids (and therefore different hashed buckets).
 */
// sql-perf-allow: index case_law_decisions_lang_group_idx bounds each correlated sibling probe
export const sitemapDocumentRepresentative = sql`${caseLawDecisions.redactedAt} IS NULL AND (
  ${caseLawDecisions.languageGroupKey} IS NULL OR NOT EXISTS (
    SELECT 1
    FROM case_law_decisions AS sitemap_sibling
    INNER JOIN case_law_sources AS sitemap_sibling_source
      ON sitemap_sibling_source.id = sitemap_sibling.source_id
    WHERE sitemap_sibling.country = ${caseLawDecisions.country}
      AND sitemap_sibling.language_group_key = ${caseLawDecisions.languageGroupKey}
      AND sitemap_sibling.id < ${caseLawDecisions.id}
      AND ${sql.raw(publishedUnredactedCaseLawDecisionSqlFor("sitemap_sibling"))}
      AND ${sql.raw(redistributableCaseLawSourceSqlFor("sitemap_sibling_source"))}
  )
)`;

// These fragments are rendered into both the SELECT list and the GROUP BY of
// the refresh's grouped read. Postgres identifies a grouped SELECT expression
// by its rendered text, and every drizzle `sql` bind parameter gets a fresh
// placeholder number per render ($1 in SELECT, $3 in GROUP BY), so a bound
// constant would make the two renderings differ and Postgres would reject the
// query ("column ... must appear in the GROUP BY clause"). The constants are
// module-level code values, never user input, so they are inlined with
// `sql.raw` (byte-identical every render) instead of bound; the shard read's
// requested `bucket` stays bound. `groupableSql` enforces the inlining at
// construction, and the refresh test executes the grouped read against
// Postgres.
export const decisionYearSql = groupableSql(
  sql<string>`COALESCE(to_char(${caseLawDecisions.decisionDate}, 'YYYY'), ${sql.raw(`'${SITEMAP_UNDATED_YEAR}'`)})`,
);
export const decisionMonthSql = groupableSql(
  sql<string>`COALESCE(to_char(${caseLawDecisions.decisionDate}, 'MM'), ${sql.raw(`'${SITEMAP_UNDATED_MONTH}'`)})`,
);
export const decisionBucketSql = groupableSql(
  sql<string>`lpad(mod(hashtext(${caseLawDecisions.id}::text)::bigint + 2147483648, ${sql.raw(String(SITEMAP_SHARD_BUCKET_COUNT))})::text, ${sql.raw(String(SITEMAP_SHARD_BUCKET_WIDTH))}, '0')`,
);
