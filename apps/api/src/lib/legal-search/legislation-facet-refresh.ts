import { panic } from "better-result";
import { and, sql } from "drizzle-orm";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import type { Transaction } from "@/api/db/root";
import {
  legislationDocuments,
  legislationFacetCounts,
  legislationFacetRefreshes,
} from "@/api/db/schema";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import { isLatestOpenedVersionOfWorkAt } from "@/api/lib/legal-search/legislation-listed-version";
import { publishedLegislationCountryFor } from "@/api/lib/legal-search/legislation-redistribution";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/** The connection the scheduler task opens; the refresh owns its transaction. */
type RefreshDb = {
  transaction: <Value>(
    run: (tx: Transaction) => Promise<Value>,
  ) => Promise<Value>;
};

/**
 * Works per admitted jurisdiction, source and kind of act, each Work counted
 * by the row the listing shows for it today. Source policy is deliberately
 * left out: the snapshot is counted per source so the public read applies the
 * policy that holds when it is read, not the one that held at the refresh.
 */
export const legislationFacetRefreshQuery = (db: Pick<Transaction, "select">) =>
  db
    .select({
      country: sql<string>`${legislationDocuments.country}`.as("country"),
      sourceId: sql<string>`${legislationDocuments.sourceId}`.as("source_id"),
      documentType: sql<string>`${legislationDocuments.documentType}`.as(
        "document_type",
      ),
      works: sql<number>`count(*)::integer`.as("works"),
    })
    .from(legislationDocuments)
    .where(
      and(
        publishedLegislationCountryFor(legislationDocuments.country),
        isLatestOpenedVersionOfWorkAt(sql`CURRENT_DATE`),
        sql`${legislationDocuments.documentType} <> ''`,
      ),
    )
    .groupBy(
      legislationDocuments.country,
      legislationDocuments.sourceId,
      legislationDocuments.documentType,
    );

type RefreshOptions = {
  signal?: AbortSignal;
  /** Kinds of act one response carries; a jurisdiction past it is reported. */
  bucketCap?: number;
};

/**
 * Replace the statute facet snapshot atomically; readers never see it
 * half-written. A jurisdiction holding more kinds of act than one response
 * carries is reported here, once per refresh, rather than on every read: the
 * read returns the most common kinds up to the cap.
 */
export const refreshLegislationFacetCounts = async (
  db: RefreshDb,
  {
    signal,
    bucketCap = LIMITS.legislationDocumentTypeBucketLimit,
  }: RefreshOptions = {},
) =>
  await withAggregateTransaction(db, async (tx) => {
    await tx.delete(legislationFacetCounts).where(sql`true`);
    await tx.execute(sql`
      INSERT INTO ${legislationFacetCounts}
        (country, source_id, document_type, works)
      SELECT country, source_id, document_type, works
      FROM (${legislationFacetRefreshQuery(tx)}) AS counted
    `);

    // Committed with the buckets: from here on the snapshot is the answer,
    // even when a reader can see none of its rows.
    await tx
      .insert(legislationFacetRefreshes)
      .values({ singleton: true, refreshedAt: sql`now()` })
      .onConflictDoUpdate({
        target: legislationFacetRefreshes.singleton,
        set: { refreshedAt: sql`now()` },
      });

    const [summary] = await tx
      .select({ buckets: sql<number>`count(*)::int` })
      .from(legislationFacetCounts);
    if (!summary) {
      panic("Legislation facet refresh aggregate returned no row.");
    }

    // One row per admitted jurisdiction, a closed list in code: the snapshot
    // counts nothing else, so more rows than that is a broken invariant.
    const kinds = await readBounded(
      tx
        .select({
          country: legislationFacetCounts.country,
          kinds: sql<number>`count(DISTINCT ${legislationFacetCounts.documentType})::int`,
        })
        .from(legislationFacetCounts)
        .groupBy(legislationFacetCounts.country),
      PUBLIC_LEGISLATION_COUNTRIES.length,
    );
    if (kinds.type === "overflow") {
      return panic(
        "Legislation facet snapshot holds a jurisdiction that is not admitted.",
      );
    }
    const overflowing = kinds.rows.filter((row) => row.kinds > bucketCap);
    for (const row of overflowing) {
      logger.warn("legislation.facets.bucket_overflow", {
        country: row.country,
        kinds: row.kinds,
        cap: bucketCap,
      });
    }
    signal?.throwIfAborted();
    return {
      buckets: summary.buckets,
      overflowing: overflowing.map((row) => row.country),
    };
  });
