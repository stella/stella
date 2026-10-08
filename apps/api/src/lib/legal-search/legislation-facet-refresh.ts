import { panic } from "better-result";
import { and, sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { legislationDocuments, legislationFacetCounts } from "@/api/db/schema";
import { isLatestOpenedVersionOfWorkAt } from "@/api/handlers/legislation/list";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { publishedLegislationCountryFor } from "@/api/lib/legal-search/legislation-redistribution";

type RefreshDb = Pick<typeof rootDb, "select" | "transaction">;

/**
 * Works per admitted jurisdiction, source and kind of act, each Work counted
 * by the row the listing shows for it today. Source policy is deliberately
 * left out: the snapshot is counted per source so the public read applies the
 * policy that holds when it is read, not the one that held at the refresh.
 */
export const legislationFacetRefreshQuery = (db: Pick<RefreshDb, "select">) =>
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

    const [summary] = await tx
      .select({ buckets: sql<number>`count(*)::int` })
      .from(legislationFacetCounts);
    if (!summary) {
      panic("Legislation facet refresh aggregate returned no row.");
    }
    signal?.throwIfAborted();
    return { buckets: summary.buckets };
  });
