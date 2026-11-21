import { panic } from "better-result";
import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

import { corpusIndexProjectionIntents } from "@/api/db/schema";
import { corpusIndexMaturationPeriodMs } from "@/api/lib/legal-search/corpus-index-config";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusIndexAppendPublishDelayMs,
  corpusProjectionAppendIngestBudgetMs,
} from "@/api/lib/legal-search/corpus-index-projection-engine";

type AcceptedAppendBarrierOrigin = { type: "accepted"; acceptedAt: SQL };
type UnknownAppendBarrierOrigin = { type: "unknown"; appendStartedAt: Date };
type OfflineExitedBarrierOrigin = { type: "offline_exited"; exitedBy: Date };
type OfflineUnendedBarrierOrigin = {
  type: "offline_unended";
  appendStartedAt: Date;
};

/**
 * Where a revision's barrier counts from. An acceptance in hand owes only the
 * publish delay. An append whose outcome is unknown counts from its start and
 * may still be inside its request, so it also owes the request's budget.
 *
 * An offline indexer publishes before it exits and nothing after, so a run
 * known to have exited owes nothing (`offline_exited`). One whose exit nobody
 * saw has certainly ended at its kill deadline plus the end margin
 * (`offline_unended`), with no commit window after it.
 */
type CorpusProjectionAppendBarrierOrigin =
  | AcceptedAppendBarrierOrigin
  | UnknownAppendBarrierOrigin
  | OfflineExitedBarrierOrigin
  | OfflineUnendedBarrierOrigin;

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
 *
 * An acceptance instant lives in PostgreSQL (a column or the transaction
 * clock), so its barrier is SQL; an unknown append's start has been read
 * back into the caller, so its barrier is a `Date`.
 */
export function corpusProjectionAppendPublishBarrier(
  origin: AcceptedAppendBarrierOrigin,
  manifest: CorpusIndexManifest,
): SQL;
export function corpusProjectionAppendPublishBarrier(
  origin:
    | UnknownAppendBarrierOrigin
    | OfflineExitedBarrierOrigin
    | OfflineUnendedBarrierOrigin,
  manifest: CorpusIndexManifest,
): Date;
export function corpusProjectionAppendPublishBarrier(
  origin: CorpusProjectionAppendBarrierOrigin,
  manifest: CorpusIndexManifest,
): SQL | Date {
  const publishDelayMs = corpusIndexAppendPublishDelayMs(manifest);
  switch (origin.type) {
    case "accepted":
      return sql`(${origin.acceptedAt}::timestamptz + ${publishDelayMs}::double precision * interval '1 millisecond')`;
    case "unknown": {
      const startedAtMs = origin.appendStartedAt.getTime();
      if (!Number.isFinite(startedAtMs)) {
        return panic("Corpus projection append barrier contract is invalid");
      }
      return new Date(
        startedAtMs +
          corpusProjectionAppendIngestBudgetMs(manifest) +
          publishDelayMs,
      );
    }
    case "offline_exited":
      return finiteInstant(origin.exitedBy, "barrier");
    case "offline_unended":
      return corpusProjectionOfflineIndexerEndedAt(
        origin.appendStartedAt,
        manifest,
      );
    default:
      origin satisfies never;
      return panic(`Unhandled append barrier origin: ${String(origin)}`);
  }
}

const finiteInstant = (instant: Date, contract: string): Date =>
  Number.isFinite(instant.getTime())
    ? instant
    : panic(`Corpus projection append ${contract} contract is invalid`);

/**
 * Clock skew between the database and the indexer's host, plus the commit of
 * a publish in flight at the kill: what the database clock must pass beyond
 * the kill deadline before the run has certainly ended.
 */
export const CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS = 5000;

/**
 * The instant, on the database clock, by which an offline indexer run that
 * delivers a revision started at `appendStartedAt` must have been killed. Its
 * runner enforces it outside the process that started it, so neither that
 * process nor its death can extend it. It is the same budget a REST append of
 * the generation gets, so the lease a start requires covers it.
 *
 * A request started in several transactions has one run, killed by the
 * deadline of its first start (`requestStartedAt` of the offline start). Every
 * later revision of it started later, so its own deadline, and the end its
 * proof waits for, falls after that kill: one deadline is safe for all.
 */
export const corpusProjectionOfflineIndexerKillDeadline = (
  appendStartedAt: Date,
  manifest: CorpusIndexManifest,
): Date =>
  new Date(
    finiteInstant(appendStartedAt, "kill deadline").getTime() +
      corpusProjectionAppendIngestBudgetMs(manifest),
  );

/**
 * How long after an offline request's first start its later transactions may
 * still start revisions into it. The run's kill deadline counts from that
 * first start, so this is the most run time starting can cost: a request of
 * 8192 revisions takes sixteen transactions of at most 512 rows, each a
 * short lock wait and one update, far inside it. A transaction past it starts
 * nothing and leaves its leases reserved for the caller to hand back.
 */
export const CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS = 60_000;

/**
 * Time after a request's kill deadline for recording its revisions: up to
 * sixteen record transactions of at most 512 rows.
 */
export const CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS = 60_000;

/**
 * The earliest lease expiry a revision may start into an offline request
 * with, given the request's first start: the shared kill deadline plus the
 * record margin, so every started revision's lease outlives its run and its
 * record. A lease that falls short is not started. For a generation with a
 * 600 s commit window the kill budget is 660 s, so a lease must reach 720 s
 * past the first start; under the 900 s lease maximum that leaves a batch at
 * most 180 s between reserving and starting a request's first revisions.
 */
export const corpusProjectionOfflineRequestLeaseFloor = (
  requestStartedAt: Date,
  manifest: CorpusIndexManifest,
): Date =>
  new Date(
    corpusProjectionOfflineIndexerKillDeadline(
      requestStartedAt,
      manifest,
    ).getTime() + CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS,
  );

/**
 * From when, on the database clock, no write of an offline run delivering a
 * revision started at `appendStartedAt` can still appear: a killed indexer
 * publishes nothing after the kill, and leaves only whole splits it had
 * published before. A census that starts no earlier than this sees all of the
 * revision it will ever see, so its count is final.
 */
export const corpusProjectionOfflineIndexerEndedAt = (
  appendStartedAt: Date,
  manifest: CorpusIndexManifest,
): Date =>
  new Date(
    corpusProjectionOfflineIndexerKillDeadline(
      appendStartedAt,
      manifest,
    ).getTime() + CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
  );

const publishBarrier = (manifest: CorpusIndexManifest): SQL =>
  corpusProjectionAppendPublishBarrier(
    {
      type: "accepted",
      acceptedAt: sql`${corpusIndexProjectionIntents.appendCommittedAt}`,
    },
    manifest,
  );

/**
 * When a committed revision that is still not exactly present counts as
 * unpublished: its stored barrier plus one more publish delay. A census that
 * finds it absent, partial or in excess before then retries on a later pass,
 * so an engine that publishes up to one window late is proven, not cleaned
 * up. Derived here and never stored.
 */
export const corpusProjectionAcceptedAppendProofDeadline = (
  appendPublishBarrierAt: Date,
  manifest: CorpusIndexManifest,
): Date => {
  const barrierMs = appendPublishBarrierAt.getTime();
  if (!Number.isFinite(barrierMs)) {
    return panic("Corpus projection proof deadline contract is invalid");
  }
  return new Date(barrierMs + corpusIndexAppendPublishDelayMs(manifest));
};

/**
 * An accepted revision's barrier: the one its acceptance stored, or, for a
 * revision applied in the transaction that accepted it, the one counted from
 * that acceptance. An ingest request stores exactly that count, so the two
 * agree for it; an offline revision stores the barrier its delivery earned,
 * which owes no commit window (`offline_exited`, `offline_unended`). The
 * stored barrier is immutable, so every writer that fences an accepted
 * revision reads it here rather than counting a second one.
 */
const acceptedRevisionBarrier = (manifest: CorpusIndexManifest): SQL =>
  sql`coalesce(${corpusIndexProjectionIntents.appendPublishBarrierAt}, ${publishBarrier(manifest)})`;

/**
 * Whether the engine has certainly published an accepted append. Only a
 * published revision may be observed: an earlier census reads a queued
 * append's absence as drift and repairs a revision that is merely late.
 */
export const corpusProjectionAppendIsPublished = (
  manifest: CorpusIndexManifest,
): SQL => sql`${acceptedRevisionBarrier(manifest)} <= clock_timestamp()`;

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
  cleanupFence(acceptedRevisionBarrier(manifest), transitionAt);

/**
 * Where a state that stopped naming `retiredRevision` goes in the append
 * walk's queue, which is ordered by `coalesce(retry_not_before, updated_at)`
 * and reads only what is runnable now: the revision's cleanup fence plus the
 * generation's split maturation period, the time a delete commonly takes to
 * settle. The walk takes no entity with an outstanding revision, so before
 * this instant it could only read such a state and refuse it. Settling the
 * revision moves the state to the present at once
 * (`wakeStatesAwaitingSettlementTx`), so this bounds the wait only when no
 * settlement of this release does.
 */
export const corpusProjectionRetiredRevisionRunnableAt = (
  manifest: CorpusIndexManifest,
  retiredRevision: SQLWrapper,
): SQL =>
  sql`((
    SELECT retired.cleanup_not_before
    FROM ${corpusIndexProjectionIntents} retired
    WHERE retired.id = ${retiredRevision}
  ) + ${corpusIndexMaturationPeriodMs(
    manifest.engine.indexConfig.indexing_settings.merge_policy
      .maturation_period,
  )}::double precision * interval '1 millisecond')`;

/**
 * The same fence for the statement that records an acceptance, which cannot
 * read the `append_committed_at` it is writing. The transition is later than
 * the acceptance it stands in for, so the barrier stays sound.
 */
export const corpusProjectionUnrecordedAppendCleanupFence = (
  manifest: CorpusIndexManifest,
  transitionAt: Date | SQL,
): CorpusProjectionCleanupFence =>
  cleanupFence(
    corpusProjectionAppendPublishBarrier(
      { type: "accepted", acceptedAt: sql`${transitionAt}` },
      manifest,
    ),
    transitionAt,
  );
