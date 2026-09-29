import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legislationDocuments,
  legislationSources,
  statuteSitemapBucket,
} from "@/api/db/schema";
import { groupableSql } from "@/api/lib/groupable-sql";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  legislationVersionRef,
  notWithdrawn,
} from "@/api/lib/legal-search/legislation-validity-window";

export const SITEMAP_ALL_BUCKET = "all";

// Drizzle must render the same expression in SELECT and GROUP BY without
// assigning distinct parameter numbers to its constants.
export const statuteBucketSql = groupableSql(
  statuteSitemapBucket(legislationDocuments.eli),
);

// A Work's newest consolidation owns its canonical slug. The Work key is
// stable across title repairs, when older versions can retain an old slug.
const canonicalSlugSql = sql<string>`(array_agg(${legislationDocuments.slug} ORDER BY coalesce(${legislationDocuments.versionValidFrom}, DATE '0001-01-01') DESC, ${legislationDocuments.id} DESC))[1]`;
const statuteLastmodSql = sql<string>`to_char(max(${legislationDocuments.updatedAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

/**
 * One published Work per row, shared by the refresh and bounded shard read.
 * Grouping by source, ELI and language keeps consolidations together; the
 * bucket is a function of that grouped ELI, so it cannot split a Work. Only
 * listed versions count, so a Work whose every version was withdrawn drops out.
 */
export const statuteWorksQuery = (
  db: Pick<Transaction, "select">,
  conditions: readonly SQL[],
) =>
  db
    .select({
      country: legislationDocuments.country,
      bucket: statuteBucketSql.as("bucket"),
      slug: canonicalSlugSql.as("slug"),
      lastmod: statuteLastmodSql.as("lastmod"),
    })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .where(
      and(
        ...conditions,
        isNotNull(legislationDocuments.slug),
        // A withdrawn version is a tombstone: it neither lists its Work nor
        // owns the Work's canonical slug.
        notWithdrawn(legislationVersionRef(legislationDocuments)),
        publishedLegislationDocument,
      ),
    )
    .groupBy(
      legislationDocuments.country,
      legislationDocuments.sourceId,
      legislationDocuments.eli,
      legislationDocuments.language,
    );
