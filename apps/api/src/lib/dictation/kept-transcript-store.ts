import { eq, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { keptTranscriptDeletions } from "@/api/db/schema";
import type { ElevenLabsEnvironment } from "@/api/lib/chat/provider-data-policy";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";

/**
 * How long a recorded transcript waits before the deletion task first tries
 * it: the request deletes it right away, and the task only takes over the
 * ones that delete did not settle.
 */
export const KEPT_TRANSCRIPT_FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;

type KeptTranscriptStoreDb = Pick<typeof rootDb, "transaction">;

type RecordKeptTranscriptOptions = {
  environment: ElevenLabsEnvironment;
  transcriptionId: string;
  db?: KeptTranscriptStoreDb;
};

/**
 * Records, durably and before the transcription answers, a transcript the
 * provider kept, so the deletion task deletes it even when the request's own
 * delete never runs or is refused. Only the provider's id is stored.
 */
export const recordKeptTranscript = async ({
  environment,
  transcriptionId,
  db = rootDb,
}: RecordKeptTranscriptOptions): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - A provider id queued for deletion; no member data and no member action.
    await tx
      .insert(keptTranscriptDeletions)
      .values({
        transcriptionId,
        environment,
        nextAttemptAt: sql`now() + (${KEPT_TRANSCRIPT_FIRST_SWEEP_DELAY_MS} * interval '1 millisecond')`,
      })
      .onConflictDoNothing({ target: keptTranscriptDeletions.transcriptionId });
  });
};

type ForgetKeptTranscriptOptions = {
  transcriptionId: string;
  db?: KeptTranscriptStoreDb;
};

/** Drops the record of a transcript the provider confirmed deleted. */
export const forgetKeptTranscript = async ({
  transcriptionId,
  db = rootDb,
}: ForgetKeptTranscriptOptions): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - The provider confirmed the delete; the queued id has no further use.
    await tx
      .delete(keptTranscriptDeletions)
      .where(eq(keptTranscriptDeletions.transcriptionId, transcriptionId));
  });
};
