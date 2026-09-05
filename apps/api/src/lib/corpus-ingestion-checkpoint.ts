import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources, legislationSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const CORPUS_SOURCE_TYPE = {
  CASE_LAW: "case-law",
  LEGISLATION: "legislation",
} as const;

export const INGESTION_CHECKPOINT_STATUS = {
  ADVANCED: "advanced",
  ALREADY_CURRENT: "already-current",
  MISSING: "missing",
  SUPERSEDED: "superseded",
} as const;

type CorpusSource =
  | {
      id: SafeId<"caseLawSource">;
      leaseToken: SafeId<"caseLawSourceIngestionLease">;
      observationOrder: bigint;
      type: typeof CORPUS_SOURCE_TYPE.CASE_LAW;
    }
  | {
      id: SafeId<"legislationSource">;
      type: typeof CORPUS_SOURCE_TYPE.LEGISLATION;
    };

type AdvanceCorpusIngestionCheckpointOptions = {
  expectedCursor: string | null;
  nextCursor: string | null;
  scopedDb: ScopedDb;
  source: CorpusSource;
};

type IngestionCheckpointResult =
  | {
      cursor: string | null;
      status:
        | typeof INGESTION_CHECKPOINT_STATUS.ADVANCED
        | typeof INGESTION_CHECKPOINT_STATUS.ALREADY_CURRENT
        | typeof INGESTION_CHECKPOINT_STATUS.SUPERSEDED;
    }
  | {
      status: typeof INGESTION_CHECKPOINT_STATUS.MISSING;
    };

type ClassifyCheckpointOptions = {
  currentCursor: string | null;
  nextCursor: string | null;
};

const classifyPersistedCheckpoint = ({
  currentCursor,
  nextCursor,
}: ClassifyCheckpointOptions): IngestionCheckpointResult =>
  currentCursor === nextCursor
    ? {
        cursor: currentCursor,
        status: INGESTION_CHECKPOINT_STATUS.ALREADY_CURRENT,
      }
    : {
        cursor: currentCursor,
        status: INGESTION_CHECKPOINT_STATUS.SUPERSEDED,
      };

/**
 * Compare-and-set the public corpus cursor loaded by an ingestion run.
 *
 * A slow run can only advance the cursor it originally observed. When
 * another run wins first, this returns the persisted winner rather than
 * moving the source backward.
 */
export const advanceCorpusIngestionCheckpoint = async ({
  expectedCursor,
  nextCursor,
  scopedDb,
  source,
}: AdvanceCorpusIngestionCheckpointOptions): Promise<IngestionCheckpointResult> =>
  await scopedDb(async (tx) => {
    switch (source.type) {
      case CORPUS_SOURCE_TYPE.CASE_LAW: {
        const advanced = await tx
          .update(caseLawSources)
          .set({
            syncCursor: nextCursor,
            lastSyncAt: new Date(),
            checkpointObservationOrder: source.observationOrder,
          })
          .where(
            and(
              eq(caseLawSources.id, source.id),
              eq(caseLawSources.ingestionLeaseToken, source.leaseToken),
              sql`${caseLawSources.ingestionLeaseExpiresAt} > now()`,
              sql`${caseLawSources.syncCursor} IS NOT DISTINCT FROM ${expectedCursor}`,
              sql`${caseLawSources.checkpointObservationOrder} <= ${source.observationOrder}`,
            ),
          )
          .returning({ cursor: caseLawSources.syncCursor });
        const winner = advanced.at(0);
        if (winner) {
          return {
            cursor: winner.cursor,
            status: INGESTION_CHECKPOINT_STATUS.ADVANCED,
          };
        }

        const current = (
          await tx
            .select({ syncCursor: caseLawSources.syncCursor })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, source.id))
            .limit(1)
        ).at(0);
        return current
          ? classifyPersistedCheckpoint({
              currentCursor: current.syncCursor,
              nextCursor,
            })
          : { status: INGESTION_CHECKPOINT_STATUS.MISSING };
      }
      case CORPUS_SOURCE_TYPE.LEGISLATION: {
        const advanced = await tx
          .update(legislationSources)
          .set({ syncCursor: nextCursor, lastSyncAt: new Date() })
          .where(
            and(
              eq(legislationSources.id, source.id),
              sql`${legislationSources.syncCursor} IS NOT DISTINCT FROM ${expectedCursor}`,
            ),
          )
          .returning({ cursor: legislationSources.syncCursor });
        const winner = advanced.at(0);
        if (winner) {
          return {
            cursor: winner.cursor,
            status: INGESTION_CHECKPOINT_STATUS.ADVANCED,
          };
        }

        const current = (
          await tx
            .select({ syncCursor: legislationSources.syncCursor })
            .from(legislationSources)
            .where(eq(legislationSources.id, source.id))
            .limit(1)
        ).at(0);
        return current
          ? classifyPersistedCheckpoint({
              currentCursor: current.syncCursor,
              nextCursor,
            })
          : { status: INGESTION_CHECKPOINT_STATUS.MISSING };
      }
      default:
        source satisfies never;
        return panic(`Unhandled source: ${String(source)}`);
    }
  });
