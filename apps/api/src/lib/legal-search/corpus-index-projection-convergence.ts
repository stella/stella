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
 * Constant-time PostgreSQL precondition for a fresh zero-drift engine census.
 * The publish probe runs only once the queue is otherwise converged, so the
 * common answer still costs one round trip.
 */
export const readCorpusIndexProjectionConvergenceTx = async (
  tx: Transaction,
  target: CorpusIndexProjectionConvergenceTarget,
): Promise<CorpusIndexProjectionConvergenceStatus> => {
  const scope = stateScope(target);
  const intentScope = and(
    eq(corpusIndexProjectionIntents.family, target.family),
    eq(corpusIndexProjectionIntents.generation, target.generation),
  );
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
    ) AS "hasPendingState",
    EXISTS (
      SELECT 1
      FROM ${corpusIndexProjectionIntents}
      WHERE ${intentScope}
        AND (
          ${inArray(
            corpusIndexProjectionIntents.status,
            CORPUS_INDEX_LAUNCH_BLOCKING_INTENT_STATUSES,
          )}
          OR (
            ${corpusIndexProjectionIntents.status} = 'applied'
            AND NOT EXISTS (
              SELECT 1
              FROM ${corpusIndexProjectionStates}
              WHERE ${scope}
                AND ${corpusIndexProjectionStates.appliedRevision} =
                    ${corpusIndexProjectionIntents.id}
            )
          )
        )
    ) AS "hasOutstandingIntent"
  `);
  const observation = rowsOf(result).at(0);
  if (
    !isRecord(observation) ||
    typeof observation["hasState"] !== "boolean" ||
    typeof observation["hasBlockedState"] !== "boolean" ||
    typeof observation["hasPendingState"] !== "boolean" ||
    typeof observation["hasOutstandingIntent"] !== "boolean"
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
  if (observation["hasOutstandingIntent"]) {
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
        intentScope,
        eq(corpusIndexProjectionIntents.status, "applied"),
        sql`NOT ${corpusProjectionAppendIsPublished(manifest)}`,
      ),
    )
    .limit(1);
  return unpublished.length === 0
    ? CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.readyForCensus
    : CORPUS_INDEX_PROJECTION_CONVERGENCE_STATUS.publishPending;
};
