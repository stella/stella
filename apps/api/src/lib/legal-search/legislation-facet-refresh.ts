import { panic } from "better-result";
import { and, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legislationDocuments,
  legislationFacetCounts,
  legislationFacetRefreshes,
} from "@/api/db/schema";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { isLatestOpenedVersionOfWorkAt } from "@/api/lib/legal-search/legislation-listed-version";
import { publishedLegislationCountryFor } from "@/api/lib/legal-search/legislation-redistribution";

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

/** Replace the statute facet snapshot atomically; readers never see it half-written. */
export const refreshLegislationFacetCounts = async (
  db: RefreshDb,
  signal?: AbortSignal,
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
    signal?.throwIfAborted();
    return { buckets: summary.buckets };
  });
