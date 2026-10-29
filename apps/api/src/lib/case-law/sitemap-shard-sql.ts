import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { redistributableCaseLawSourceSqlFor } from "@/api/lib/case-law/redistribution-sql";
import { groupableSql } from "@/api/lib/groupable-sql";
import { LIMITS } from "@/api/lib/limits";

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
export const SITEMAP_MULTILINGUAL_URL_WEIGHT =
  LIMITS.caseLawSitemapShardUrlLimit /
  LIMITS.caseLawSitemapMultilingualShardUrlLimit;

/**
 * One stable eligible row per document, chosen across all dates and buckets.
 * Filtering a shard's rows afterwards would repeat documents whose language
 * versions have different ids (and therefore different hashed buckets).
 * A scalar, capped sibling probe keeps the language-group index condition;
 * null group keys match no sibling and therefore remain representatives.
 * Callers pass a published row, so the probe compares published siblings only.
 */
export const sitemapDocumentRepresentativeFor = (decision: {
  id: SQLWrapper;
  country: SQLWrapper;
  languageGroupKey: SQLWrapper;
}) => sql`(
    SELECT 1
    FROM ${publishedCaseLawDecisions} AS sitemap_sibling
    INNER JOIN ${caseLawSources} AS sitemap_sibling_source
      ON sitemap_sibling_source.id = sitemap_sibling.source_id
    WHERE sitemap_sibling.country = ${decision.country}
      AND sitemap_sibling.language_group_key = ${decision.languageGroupKey}
      AND sitemap_sibling.id < ${decision.id}
      AND ${sql.raw(redistributableCaseLawSourceSqlFor("sitemap_sibling_source"))}
    LIMIT 1
) IS NULL`;

/** A group identity also exists for monolingual documents; only a published,
 * redistributable sibling in another language can add hreflang links. */
export const sitemapHasLanguageAlternatesFor = (decision: {
  country: SQLWrapper;
  languageGroupKey: SQLWrapper;
  language: SQLWrapper;
}) => sql<boolean>`EXISTS (
    SELECT 1
    FROM ${publishedCaseLawDecisions} AS sitemap_alternate
    INNER JOIN ${caseLawSources} AS sitemap_alternate_source
      ON sitemap_alternate_source.id = sitemap_alternate.source_id
    WHERE sitemap_alternate.country = ${decision.country}
      AND sitemap_alternate.language_group_key = ${decision.languageGroupKey}
      AND sitemap_alternate.language <> ${decision.language}
      AND ${sql.raw(redistributableCaseLawSourceSqlFor("sitemap_alternate_source"))}
    LIMIT 1
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
export const decisionYearSqlFor = (table: { decisionDate: SQLWrapper }) =>
  groupableSql(
    sql<string>`COALESCE(to_char(${table.decisionDate}, 'YYYY'), ${sql.raw(`'${SITEMAP_UNDATED_YEAR}'`)})`,
  );
export const decisionMonthSqlFor = (table: { decisionDate: SQLWrapper }) =>
  groupableSql(
    sql<string>`COALESCE(to_char(${table.decisionDate}, 'MM'), ${sql.raw(`'${SITEMAP_UNDATED_MONTH}'`)})`,
  );
export const decisionBucketSqlFor = (table: { id: SQLWrapper }) =>
  groupableSql(
    sql<string>`lpad(mod(hashtext(${table.id}::text)::bigint + 2147483648, ${sql.raw(String(SITEMAP_SHARD_BUCKET_COUNT))})::text, ${sql.raw(String(SITEMAP_SHARD_BUCKET_WIDTH))}, '0')`,
  );
