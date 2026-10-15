import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";

const SOURCE_INGESTION_LEASE_MS = 60 * 60 * 1000;

export type CaseLawSourceLeasePurpose =
  (typeof caseLawSources.$inferSelect)["ingestionLeasePurpose"];

export type CaseLawSourceIngestionLease = {
  beforeDatabaseMark: () => Promise<void>;
  beforeRemoteEffect: <T>(effect: () => Promise<T>) => Promise<T>;
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  purpose: CaseLawSourceLeasePurpose;
  release: () => Promise<void>;
  source: typeof caseLawSources.$inferSelect;
};

const DECISION_MERGE_EPOCH_ADVANCE = {
  ingestion: 0,
  "decision-merge": 1,
} as const satisfies Record<CaseLawSourceLeasePurpose, number>;

type AcquireCaseLawSourceIngestionLeaseOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  purpose?: CaseLawSourceLeasePurpose;
  /** Cleanup may need a fresh bounded schema-lane retry after work stopped. */
  releaseDb?: ScopedDb;
};

const nextLeaseExpiry = (): Date =>
  new Date(
    Temporal.Now.instant().epochMilliseconds + SOURCE_INGESTION_LEASE_MS,
  );

/**
 * Claim the single fetch/checkpoint writer for one source without holding a
 * database connection across remote I/O. Every caller receives the source row
 * read after the claim, so a replacement cannot start from a pre-lease cursor.
 */
export const acquireCaseLawSourceIngestionLease = async ({
  scopedDb,
  sourceId,
  purpose = "ingestion",
  releaseDb = scopedDb,
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
          ingestionLeasePurpose: purpose,
          decisionMergeEpoch: sql`${caseLawSources.decisionMergeEpoch} + ${DECISION_MERGE_EPOCH_ADVANCE[purpose]}`,
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

  const renewLeaseTx = async (tx: Transaction) => {
    // audit: skip — renews ephemeral ownership without domain mutation
    const renewed = await tx
      .update(caseLawSources)
      .set({
        ingestionLeaseExpiresAt: nextLeaseExpiry(),
        updatedAt: sql`${caseLawSources.updatedAt}`,
      })
      .where(
        and(
          eq(caseLawSources.id, sourceId),
          eq(caseLawSources.ingestionLeaseToken, leaseToken),
          eq(caseLawSources.ingestionLeasePurpose, purpose),
          sql`${caseLawSources.ingestionLeaseExpiresAt} > now()`,
        ),
      )
      .returning({ id: caseLawSources.id });
    return renewed.at(0);
  };

  const beforeDatabaseMark = async (): Promise<void> => {
    const renewed = await scopedDb(renewLeaseTx);
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
    purpose,
    release: async () => {
      await releaseDb(async (tx) => {
        // audit: skip — releases only this caller's ephemeral lease
        await tx
          .update(caseLawSources)
          .set({
            ingestionLeaseExpiresAt: null,
            ingestionLeaseToken: null,
            ingestionLeasePurpose: "ingestion",
            updatedAt: sql`${caseLawSources.updatedAt}`,
          })
          .where(
            and(
              eq(caseLawSources.id, sourceId),
              eq(caseLawSources.ingestionLeaseToken, leaseToken),
              eq(caseLawSources.ingestionLeasePurpose, purpose),
            ),
          );
      });
    },
    source,
  };
};
