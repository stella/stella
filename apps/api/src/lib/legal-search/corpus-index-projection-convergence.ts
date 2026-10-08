import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_LAUNCH_BLOCKING_INTENT_STATUSES } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { readRegisteredCorpusProjectionManifestForCleanup } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { corpusProjectionAppendIsPublished } from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  corpusIndexProjectionIsBlocked,
  corpusIndexProjectionNeedsWork,
} from "@/api/lib/legal-search/corpus-index-projection-sql";
import { isRecord } from "@/api/lib/type-guards";

const CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS = {
  empty: "empty",
  knownBlocked: "known_blocked",
  pending: "pending",
  intentOutstanding: "intent_outstanding",
  /**
   * Every revision is applied, but the engine has not certainly published
   * the most recent ones. A census run now would inspect a strict subset of
   * the generation and still read as complete, so the proof waits.
   */
  publishPending: "publish_pending",
  readyForCensus: "ready_for_census",
} as const;

export type CorpusIndexProjectionConvergenceStatus =
  (typeof CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS)[keyof typeof CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS];

type CorpusIndexProjectionConvergenceTarget = {
  family: CorpusFamily;
  generation: string;
};

const stateScope = ({
  family,
  generation,
}: CorpusIndexProjectionConvergenceTarget) =>
  and(
    eq(corpusIndexProjectionStates.family, family),
    eq(corpusIndexProjectionStates.generation, generation),
  );

const intentScope = ({
  family,
  generation,
}: CorpusIndexProjectionConvergenceTarget) =>
  and(
    eq(corpusIndexProjectionIntents.family, family),
    eq(corpusIndexProjectionIntents.generation, generation),
  );

/**
 * Every "is there one?" question here reads the first row of the index that
 * answers it, never an `EXISTS`. PostgreSQL plans an `EXISTS` for an early
 * hit and drops its ORDER BY and LIMIT, so when nothing matches it can read
 * the whole table to prove so. Ordered by the index keys after the equality
 * columns, any other path has to sort the generation first, so the index is
 * the plan under custom and generic planning alike. A partial index's
 * predicate is repeated through the helper that defines it, which is what
 * lets the planner use the index at all.
 */
export const corpusProjectionStateQueueProbe = (
  target: CorpusIndexProjectionConvergenceTarget,
) => {
  const states = corpusIndexProjectionStates;
  const scope = stateScope(target);
  return sql`
    SELECT (
      SELECT ${states.entityId}
      FROM ${states}
      WHERE ${scope}
      ORDER BY ${states.entityId}
      LIMIT 1
    ) IS NOT NULL AS "hasState",
    (
      SELECT ${states.entityId}
      FROM ${states}
      WHERE ${scope}
        AND ${corpusIndexProjectionIsBlocked(states.workStatus)}
      ORDER BY ${states.entityId}
      LIMIT 1
    ) IS NOT NULL AS "hasBlockedState",
    (
      SELECT ${states.entityId}
      FROM ${states}
      WHERE ${scope}
        AND ${corpusIndexProjectionNeedsWork(states)}
      ORDER BY coalesce(${states.retryNotBefore}, ${states.updatedAt}),
        ${states.entityId}
      LIMIT 1
    ) IS NOT NULL AS "hasPendingState"
  `;
};

/**
 * Whether any revision of the generation can still change the engine, asked
 * only once the state queue is quiet.
 *
 * "Outstanding" is unchanged: a blocking revision, or an `applied` revision
 * that no state row names as authoritative. A blocking revision is the first
 * row of one blocking status in work-index order, one probe per status, so
 * the probe never walks applied or settled history. Read as an anti-join,
 * the second half probes the state index once per applied revision, so it
 * grew with the generation while holding the exclusive mutation fence. The
 * same question is a count identity, and two index-only scans answer it:
 *
 * - `applied_revision` is a foreign key carrying family, generation, entity,
 *   epoch, fingerprint and index id, and the applied shape check makes those
 *   columns non-null exactly when `applied_revision` is, so every reference
 *   names a revision of this generation and neither count leaves the scope.
 * - `corpus_index_projection_states_applied_revision_uidx` is unique, so
 *   distinct states name distinct revisions and the reference count is the
 *   number of referenced revisions.
 * - Every path that takes a referenced revision out of `applied` (replacement
 *   preparation, erasure claim, census drift repair) leaves that entity's
 *   state needing work or blocked in the same transaction, and the reference
 *   is repointed or cleared only when the state converges again. Reaching
 *   this question means no such state exists, so the referenced revisions are
 *   a subset of the applied ones and the counts agree exactly when every
 *   applied revision is referenced.
 */
export const corpusProjectionOutstandingIntentProbe = (
  target: CorpusIndexProjectionConvergenceTarget,
) => {
  const intents = corpusIndexProjectionIntents;
  // COALESCE stops at the first status with a revision, so a generation with
  // blocking work runs the probes up to that status and no count.
  const blockingRevisions = CORPUS_INDEX_LAUNCH_BLOCKING_INTENT_STATUSES.map(
    (status) => sql`(
      SELECT ${intents.status}
      FROM ${intents}
      WHERE ${intentScope(target)}
        AND ${intents.status} = ${status}
      ORDER BY ${intents.cleanupNotBefore}, ${intents.leaseExpiresAt},
        ${intents.createdAt}
      LIMIT 1
    )`,
  );
  return sql`
    SELECT COALESCE(${sql.join(blockingRevisions, sql`, `)}) IS NOT NULL OR (
      SELECT count(*)
      FROM ${intents}
      WHERE ${intentScope(target)}
        AND ${intents.status} = 'applied'
    ) <> (
      SELECT count(*)
      FROM ${corpusIndexProjectionStates}
      WHERE ${stateScope(target)}
        -- The applied shape check makes these two conjuncts one condition.
        -- Spelling both is what the applied-census partial index requires to
        -- answer the count without touching the table.
        AND ${corpusIndexProjectionStates.appliedAction} = 'upsert'
        AND ${corpusIndexProjectionStates.appliedRevision} IS NOT NULL
    ) AS "hasOutstandingIntent"
  `;
};

/**
 * One applied revision the engine has not certainly published, if any. An
 * applied revision carries no cleanup or lease timestamps, so the order is
 * the work index's own: the probe reads the generation's applied revisions,
 * never the table.
 */
export const corpusProjectionUnpublishedIntentProbe = (
  target: CorpusIndexProjectionConvergenceTarget,
  manifest: CorpusIndexManifest,
) => {
  const intents = corpusIndexProjectionIntents;
  return sql`
    SELECT ${intents.id}
    FROM ${intents}
    WHERE ${intentScope(target)}
      AND ${intents.status} = 'applied'
      AND NOT ${corpusProjectionAppendIsPublished(manifest)}
    ORDER BY ${intents.cleanupNotBefore}, ${intents.leaseExpiresAt},
      ${intents.createdAt}
    LIMIT 1
  `;
};

const readOutstandingCorpusProjectionIntentTx = async (
  tx: Transaction,
  target: CorpusIndexProjectionConvergenceTarget,
): Promise<boolean> => {
  const result: unknown = await tx.execute(
    corpusProjectionOutstandingIntentProbe(target),
  );
  const observation = executedRows(result).at(0);
  if (
    !isRecord(observation) ||
    typeof observation["hasOutstandingIntent"] !== "boolean"
  ) {
    return panic("Corpus projection intent probe returned malformed row");
  }
  return observation["hasOutstandingIntent"];
};

/**
 * PostgreSQL precondition for a fresh zero-drift engine census. The state
 * queue answers in one round trip; the intent and publish probes run only once
 * it is quiet, so a generation with work left still costs one round trip.
 */
export const readCorpusIndexProjectionConvergenceTx = async (
  tx: Transaction,
  target: CorpusIndexProjectionConvergenceTarget,
): Promise<CorpusIndexProjectionConvergenceStatus> => {
  const result: unknown = await tx.execute(
    corpusProjectionStateQueueProbe(target),
  );
  const observation = executedRows(result).at(0);
  if (
    !isRecord(observation) ||
    typeof observation["hasState"] !== "boolean" ||
    typeof observation["hasBlockedState"] !== "boolean" ||
    typeof observation["hasPendingState"] !== "boolean"
  ) {
    return panic("Corpus projection convergence probe returned malformed row");
  }
  if (!observation["hasState"]) {
    return CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.empty;
  }
  if (observation["hasPendingState"]) {
    return CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.pending;
  }
  if (await readOutstandingCorpusProjectionIntentTx(tx, target)) {
    return CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.intentOutstanding;
  }
  if (observation["hasBlockedState"]) {
    return CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.knownBlocked;
  }
  const manifest = await readRegisteredCorpusProjectionManifestForCleanup(
    tx,
    target.family,
    target.generation,
  );
  const unpublished = executedRows(
    await tx.execute(corpusProjectionUnpublishedIntentProbe(target, manifest)),
  );
  return unpublished.length === 0
    ? CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.readyForCensus
    : CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.publishPending;
};
