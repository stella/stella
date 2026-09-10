import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { CORPUS_INDEX_LAUNCH_BLOCKING_INTENT_STATUSES } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { readRegisteredCorpusProjectionManifestForCleanup } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { corpusProjectionAppendIsPublished } from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  corpusIndexProjectionIsBlocked,
  corpusIndexProjectionNeedsWork,
} from "@/api/lib/legal-search/corpus-index-projection-sql";
import { isRecord } from "@/api/lib/type-guards";

export const CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS = {
  empty: "empty",
  blocked: "blocked",
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

const rowsOf = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

/**
 * Whether any revision of the generation can still change the engine, asked
 * only once the state queue is quiet.
 *
 * "Outstanding" is unchanged: a blocking revision, or an `applied` revision
 * that no state row names as authoritative. Read as an anti-join, the second
 * half probes the state index once per applied revision, so it grew with the
 * generation while holding the exclusive mutation fence. The same question is
 * a count identity, and two index-only scans answer it:
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
const readOutstandingCorpusProjectionIntentTx = async (
  tx: Transaction,
  target: CorpusIndexProjectionConvergenceTarget,
): Promise<boolean> => {
  const result: unknown = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM ${corpusIndexProjectionIntents}
      WHERE ${intentScope(target)}
        AND ${inArray(
          corpusIndexProjectionIntents.status,
          CORPUS_INDEX_LAUNCH_BLOCKING_INTENT_STATUSES,
        )}
    ) OR (
      SELECT count(*)
      FROM ${corpusIndexProjectionIntents}
      WHERE ${intentScope(target)}
        AND ${corpusIndexProjectionIntents.status} = 'applied'
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
  `);
  const observation = rowsOf(result).at(0);
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
  const scope = stateScope(target);
  const result: unknown = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${corpusIndexProjectionStates} WHERE ${scope}
    ) AS "hasState",
    EXISTS (
      SELECT 1
      FROM ${corpusIndexProjectionStates}
      WHERE ${scope}
        AND ${corpusIndexProjectionIsBlocked(
          corpusIndexProjectionStates.workStatus,
        )}
    ) AS "hasBlockedState",
    EXISTS (
      SELECT 1
      FROM ${corpusIndexProjectionStates}
      WHERE ${scope}
        AND ${corpusIndexProjectionNeedsWork(corpusIndexProjectionStates)}
    ) AS "hasPendingState"
  `);
  const observation = rowsOf(result).at(0);
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
  if (observation["hasBlockedState"]) {
    return CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.blocked;
  }
  if (observation["hasPendingState"]) {
    return CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.pending;
  }
  if (await readOutstandingCorpusProjectionIntentTx(tx, target)) {
    return CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.intentOutstanding;
  }
  const manifest = await readRegisteredCorpusProjectionManifestForCleanup(
    tx,
    target.family,
    target.generation,
  );
  const unpublished = await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        intentScope(target),
        eq(corpusIndexProjectionIntents.status, "applied"),
        sql`NOT ${corpusProjectionAppendIsPublished(manifest)}`,
      ),
    )
    .limit(1);
  return unpublished.length === 0
    ? CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.readyForCensus
    : CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.publishPending;
};
