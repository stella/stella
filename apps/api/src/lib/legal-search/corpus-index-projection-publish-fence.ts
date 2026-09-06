import { sql, type SQL } from "drizzle-orm";

import { corpusIndexProjectionIntents } from "@/api/db/schema";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexAppendPublishDelayMs } from "@/api/lib/legal-search/corpus-index-projection-engine";

/**
 * One owner of the rule that separates "the engine accepted this append"
 * from "the engine published it". Every reader and every delete that
 * observes an accepted revision goes through here, so a queued append
 * cannot be read as drift by one caller and deleted early by another.
 *
 * The barrier schedules, it does not prove: the commit policy bounds the
 * engine's own commit window, not the queueing in front of it, so a
 * backlogged or restarting engine can still publish later than this. What
 * proves the two observations behind it is exact, and repairs them when the
 * engine was late, is unchanged: a cleanup settles only once published
 * splits cross its delete opstamp and a revision query observes zero
 * remaining documents, and a census that inspects a revision too early
 * reports drift, which repairs the entity rather than losing it.
 */
const publishBarrierFrom = (
  acceptedAt: SQL,
  manifest: CorpusIndexManifest,
): SQL =>
  sql`(${acceptedAt}::timestamptz + ${corpusIndexAppendPublishDelayMs(manifest)}::double precision * interval '1 millisecond')`;

const publishBarrier = (manifest: CorpusIndexManifest): SQL =>
  publishBarrierFrom(
    sql`${corpusIndexProjectionIntents.appendCommittedAt}`,
    manifest,
  );

/**
 * Whether the engine has certainly published an accepted append. Only a
 * published revision may be observed: an earlier census reads a queued
 * append's absence as drift and repairs a revision that is merely late.
 */
export const corpusProjectionAppendIsPublished = (
  manifest: CorpusIndexManifest,
): SQL => sql`${publishBarrier(manifest)} <= clock_timestamp()`;

type CorpusProjectionCleanupFence = {
  appendPublishBarrierAt: SQL;
  cleanupNotBefore: SQL;
};

const cleanupFence = (
  barrier: SQL,
  transitionAt: Date | SQL,
): CorpusProjectionCleanupFence => ({
  appendPublishBarrierAt: barrier,
  cleanupNotBefore: sql`GREATEST(${transitionAt}::timestamptz, ${barrier})`,
});

/**
 * The cleanup fence for a revision the engine has already accepted. Deletes
 * are opstamp-ordered against published splits, so a delete issued before
 * the barrier never reaches the documents still inside the commit window and
 * leaves them in the index forever; the barrier is what keeps cleanup exact
 * under a queued append.
 */
export const corpusProjectionAcceptedAppendCleanupFence = (
  manifest: CorpusIndexManifest,
  transitionAt: Date | SQL,
): CorpusProjectionCleanupFence =>
  cleanupFence(publishBarrier(manifest), transitionAt);

/**
 * The same fence for the one path that retires an acceptance it is still
 * holding, before `append_committed_at` is on the row. The transition is
 * later than the acceptance it stands in for, so the barrier stays sound.
 */
export const corpusProjectionUnrecordedAppendCleanupFence = (
  manifest: CorpusIndexManifest,
  transitionAt: Date | SQL,
): CorpusProjectionCleanupFence =>
  cleanupFence(
    publishBarrierFrom(sql`${transitionAt}`, manifest),
    transitionAt,
  );
