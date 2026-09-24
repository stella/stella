import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";

type SourceObservation = { order: bigint };

/** The row as read still predates this observation, so it may write it. */
export const observationStillOwns = (
  row: { sourceObservationOrder: bigint | null } | undefined,
  order: bigint,
): boolean =>
  row !== undefined &&
  (row.sourceObservationOrder === null || row.sourceObservationOrder < order);

export const storedObservationPrecedes = ({ order }: SourceObservation) =>
  or(
    isNull(caseLawDecisions.sourceObservationOrder),
    lt(caseLawDecisions.sourceObservationOrder, order),
  );

type AllocateSourceObservationOrderOptions = {
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * Take the next observation order for a source, under the lease that owns
 * its ingestion. Exported so an operator replay orders its writes on the
 * same counter a crawl does: the row-level guards compare orders, so a
 * replay that minted its own numbering could overwrite a newer observation.
 */
export const allocateSourceObservationOrder = async ({
  leaseToken,
  scopedDb,
  sourceId,
}: AllocateSourceObservationOrderOptions): Promise<bigint> =>
  await scopedDb(async (tx) => {
    // audit: skip — background ingestion ordering state for public source data
    const allocated = (
      await tx
        .update(caseLawSources)
        .set({
          observationOrder: sql`${caseLawSources.observationOrder} + 1`,
          updatedAt: sql`${caseLawSources.updatedAt}`,
        })
        .where(
          and(
            eq(caseLawSources.id, sourceId),
            eq(caseLawSources.ingestionLeaseToken, leaseToken),
            sql`${caseLawSources.ingestionLeaseExpiresAt} > now()`,
          ),
        )
        .returning({ order: caseLawSources.observationOrder })
    ).at(0);
    if (!allocated) {
      throw new ConcurrentModificationError({
        message: "Case-law source ingestion lease was lost before ordering",
      });
    }
    return allocated.order;
  });
