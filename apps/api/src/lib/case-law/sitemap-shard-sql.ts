import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { decisionDateSortKeySql } from "@/api/lib/case-law/decision-date-order";
import { redistributableCaseLawSourceSqlFor } from "@/api/lib/case-law/redistribution-sql";
import { groupableSql } from "@/api/lib/groupable-sql";

/**
 * How the public case-law sitemap names its shards: a country's month, or its
 * undated decisions, and the ranges of a split month. Shared by the refresh
 * that lists the shards, the touch fold that dates them and the shard read
 * that serves one.
 */
export const SITEMAP_UNDATED_YEAR = "undated";
export const SITEMAP_UNDATED_MONTH = "00";
export const SITEMAP_ALL_BUCKET = "all";

/** A range's name is its position in the month, zero-padded to this width. */
const SITEMAP_RANGE_BUCKET_WIDTH = 4;
/** The most ranges one month can be cut into under its four-digit names. */
export const SITEMAP_RANGES_PER_MONTH_MAX = 10 ** SITEMAP_RANGE_BUCKET_WIDTH;
export const SITEMAP_BUCKET_PATTERN = `^(?:${SITEMAP_ALL_BUCKET}|[0-9]{${String(SITEMAP_RANGE_BUCKET_WIDTH)}})$`;

/** The name of the range at `position` (from 0) of a split month. */
export const sitemapRangeBucket = (position: number): string =>
  String(position).padStart(SITEMAP_RANGE_BUCKET_WIDTH, "0");

/**
 * A position on the key of `case_law_decisions_country_date_published_idx`
 * within one country: the decision date (`-infinity` when undated), then the
 * id. Neither changes when a decision is rewritten, so a decision stays in its
 * range until its month is cut again.
 */
type SitemapRangeKey = { date: string; id: string };

/**
 * One file's slice of a month: from `start` (inclusive) to `end` (exclusive),
 * an absent bound being the month's own edge. An unsplit month has neither.
 */
export type SitemapRange = {
  start: SitemapRangeKey | null;
  end: SitemapRangeKey | null;
};

/** A decision's position on the range key, as a row the index orders. */
export const sitemapRangeKeySql = (decision: {
  decisionDate: SQLWrapper;
  id: SQLWrapper;
}): SQL =>
  sql`(${decisionDateSortKeySql(decision.decisionDate)}, ${decision.id})`;

const rangeKeyLiteral = ({ date, id }: SitemapRangeKey): SQL =>
  sql`(${date}::date, ${id}::uuid)`;

/**
 * The conditions that keep `decision` inside `range`: one row comparison per
 * bound on the expressions the date index stores, so a range is read as one
 * index range.
 */
export const sitemapRangeConditionsFor = (
  decision: { decisionDate: SQLWrapper; id: SQLWrapper },
  { start, end }: SitemapRange,
): SQL[] => {
  const key = sitemapRangeKeySql(decision);
  return [
    ...(start === null ? [] : [sql`${key} >= ${rangeKeyLiteral(start)}`]),
    ...(end === null ? [] : [sql`${key} < ${rangeKeyLiteral(end)}`]),
  ];
};

/**
 * One stable eligible row per document, chosen across all dates and ranges.
 * Filtering a shard's rows afterwards would repeat documents whose language
 * versions have different ids (and therefore can fall in different ranges).
 * A scalar, capped sibling probe keeps the language-group index condition;
 * null group keys match no sibling and therefore remain representatives.
 * Callers pass a published row, so the probe compares published siblings only.
 * `case_law_decisions_language_group_published_idx` carries everything both
 * probes read, so a month's probes visit no heap page of an all-visible table.
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

/** Group keys also identify monolingual documents; only an eligible sibling
 * in another language gives a listed decision hreflang alternates. */
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
// `sql.raw` (byte-identical every render) instead of bound. `groupableSql`
// enforces the inlining at construction, and the fold test executes the
// grouped read against Postgres.
export const decisionYearSqlFor = (table: { decisionDate: SQLWrapper }) =>
  groupableSql(
    sql<string>`COALESCE(to_char(${table.decisionDate}, 'YYYY'), ${sql.raw(`'${SITEMAP_UNDATED_YEAR}'`)})`,
  );
export const decisionMonthSqlFor = (table: { decisionDate: SQLWrapper }) =>
  groupableSql(
    sql<string>`COALESCE(to_char(${table.decisionDate}, 'MM'), ${sql.raw(`'${SITEMAP_UNDATED_MONTH}'`)})`,
  );
/**
 * A shard's last modification: the newest `updated_at` of the decisions it
 * lists, at the millisecond precision the shard row and the sitemap carry.
 * The month recount and the touch fold both write it, so a fold compares and
 * stores exactly what a recount of the same rows would.
 */
export const sitemapLastModifiedSqlFor = (decision: {
  updatedAt: SQLWrapper;
}) => sql`date_trunc('milliseconds', max(${decision.updatedAt}))`;
