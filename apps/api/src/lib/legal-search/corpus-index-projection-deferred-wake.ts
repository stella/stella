/**
 * The operator's wake of projection states an earlier release queued at a
 * retired revision's settlement bound, in a generation whose hits carry their
 * revision.
 *
 * Such a generation appends a new revision beside an older one whose exact
 * delete is in flight (`CORPUS_INDEX_INTENT_APPEND_GATE`), and this release
 * queues a state that stops naming its copy at once
 * (`corpusProjectionRetiredRevisionRunnableAt`). A state queued for later by
 * an earlier release stays out of the append walk until then. The wake moves
 * to the present exactly the states the walk would take but for that instant
 * (`corpusProjectionDeferredAppendStates`, built from the walk's own
 * predicate): nothing else, and only `updated_at`.
 *
 * It never waits: each batch takes the rows no writer holds, under a short
 * lock timeout, and what it passed over is counted afterwards for a rerun. A
 * woken row leaves the predicate, so running it again wakes only what is
 * left.
 */
import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { corpusIndexProjectionStates } from "@/api/db/schema";
import { setSharedLockTimeout } from "@/api/db/shared-pool-timeouts";
import type { Transaction } from "@/api/db/types";
import {
  corpusProjectionDeferredAppendStates,
  wakeCorpusProjectionStatesQuery,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import type { CorpusRevisionRetrieval } from "@/api/lib/legal-search/corpus-index-manifest";
import { isRecord } from "@/api/lib/type-guards";

/** A generation whose hits carry their revision: the only kind woken. */
export type DeferredWakeTarget = {
  family: CorpusFamily;
  generation: string;
  retrieval: Extract<CorpusRevisionRetrieval, { type: "stored" }>;
};

/** The states owed a wake: how many, and a digest of their ids in order. */
export type DeferredAppendStates = { count: number; idsSha256: string };

/** How long a batch waits for any lock (a flip's fence) before it gives up. */
export const DEFERRED_WAKE_LOCK_TIMEOUT_MS = 1000;

const deferred = (target: DeferredWakeTarget) =>
  corpusProjectionDeferredAppendStates(target);

/**
 * Counts the states owed a wake and digests their ids (sha256 of the sorted
 * ids joined by commas), so a dry run and the apply that follows it can be
 * compared.
 */
export const readDeferredAppendStatesTx = async (
  tx: Transaction,
  target: DeferredWakeTarget,
): Promise<DeferredAppendStates> => {
  const states = corpusIndexProjectionStates;
  const row = executedRows(
    await tx.execute(sql`
      SELECT count(*)::int AS count,
        encode(sha256(convert_to(coalesce(
          string_agg(${states.entityId}::text, ',' ORDER BY ${states.entityId}),
          ''
        ), 'UTF8')), 'hex') AS ids_sha256
      FROM ${states}
      WHERE ${deferred(target)}`),
  ).at(0);
  if (
    !isRecord(row) ||
    typeof row["count"] !== "number" ||
    typeof row["ids_sha256"] !== "string"
  ) {
    return panic("The deferred-state count returned an invalid row");
  }
  return { count: row["count"], idsSha256: row["ids_sha256"] };
};

/**
 * Wakes up to `limit` owed states in one transaction and returns how many it
 * woke; a row a writer holds is left for a later batch or run.
 */
export const wakeDeferredAppendStatesBatchTx = async (
  tx: Transaction,
  target: DeferredWakeTarget,
  limit: number,
): Promise<number> => {
  await setSharedLockTimeout(tx, DEFERRED_WAKE_LOCK_TIMEOUT_MS);
  // audit: skip - scheduling bookkeeping on the derived public corpus projection
  return executedRows(
    await tx.execute(
      wakeCorpusProjectionStatesQuery({ where: deferred(target), limit }),
    ),
  ).length;
};
