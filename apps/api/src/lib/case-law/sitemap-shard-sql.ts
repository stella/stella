import { sql } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
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
