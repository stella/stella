import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";

const SOURCE_INGESTION_LEASE_MS = 60 * 60 * 1000;

export type CaseLawSourceIngestionLease = {
  beforeDatabaseMark: () => Promise<void>;
  beforeRemoteEffect: <T>(effect: () => Promise<T>) => Promise<T>;
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  release: () => Promise<void>;
  source: typeof caseLawSources.$inferSelect;
};

type AcquireCaseLawSourceIngestionLeaseOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
};

const nextLeaseExpiry = (): Date =>
  new Date(Date.now() + SOURCE_INGESTION_LEASE_MS);

/**
 * Claim the single fetch/checkpoint writer for one source without holding a
 * database connection across remote I/O. Every caller receives the source row
 * read after the claim, so a replacement cannot start from a pre-lease cursor.
 */
export const acquireCaseLawSourceIngestionLease = async ({
  scopedDb,
  sourceId,
}: AcquireCaseLawSourceIngestionLeaseOptions): Promise<CaseLawSourceIngestionLease | null> => {
  const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
  const source = await scopedDb(async (tx) => {
    // audit: skip — ephemeral mutual-exclusion state for public ingestion
    const claimed = (
      await tx
        .update(caseLawSources)
        .set({
          ingestionLeaseExpiresAt: nextLeaseExpiry(),
          ingestionLeaseToken: leaseToken,
          updatedAt: sql`${caseLawSources.updatedAt}`,
        })
        .where(
          and(
            eq(caseLawSources.id, sourceId),
            or(
              isNull(caseLawSources.ingestionLeaseToken),
              lte(caseLawSources.ingestionLeaseExpiresAt, sql`now()`),
            ),
          ),
        )
        .returning({ id: caseLawSources.id })
    ).at(0);
    if (!claimed) {
      return null;
    }
    return (
      await tx
        .select()
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
        .limit(1)
    ).at(0);
  });
  if (!source) {
    return null;
  }

  const beforeDatabaseMark = async (): Promise<void> => {
    // eslint-disable-next-line arrow-body-style -- block body keeps the audit directive inside the mutation callback
    const renewed = await scopedDb(async (tx) => {
      // audit: skip — renews ephemeral ownership without domain mutation
      return (
        await tx
          .update(caseLawSources)
          .set({
            ingestionLeaseExpiresAt: nextLeaseExpiry(),
            updatedAt: sql`${caseLawSources.updatedAt}`,
          })
          .where(
            and(
              eq(caseLawSources.id, sourceId),
              eq(caseLawSources.ingestionLeaseToken, leaseToken),
              sql`${caseLawSources.ingestionLeaseExpiresAt} > now()`,
            ),
          )
          .returning({ id: caseLawSources.id })
      ).at(0);
    });
    if (!renewed) {
      throw new ConcurrentModificationError({
        message: "Case-law source ingestion lease was lost",
      });
    }
  };

  return {
    beforeDatabaseMark,
    beforeRemoteEffect: async (effect) => {
      await beforeDatabaseMark();
      const result = await effect();
      await beforeDatabaseMark();
      return result;
    },
    leaseToken,
    release: async () => {
      await scopedDb(async (tx) => {
        // audit: skip — releases only this caller's ephemeral lease
        await tx
          .update(caseLawSources)
          .set({
            ingestionLeaseExpiresAt: null,
            ingestionLeaseToken: null,
            updatedAt: sql`${caseLawSources.updatedAt}`,
          })
          .where(
            and(
              eq(caseLawSources.id, sourceId),
              eq(caseLawSources.ingestionLeaseToken, leaseToken),
            ),
          );
      });
    },
    source,
  };
};
