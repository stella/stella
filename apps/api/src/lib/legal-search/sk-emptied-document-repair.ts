import { panic, Result, TaggedError } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { lockCaseLawDecisionRows } from "@/api/lib/db/aggregate-lock";
import { recordCorpusWithdrawalAuditEvent } from "@/api/lib/legal-search/corpus-index-job-audit";
import {
  CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE,
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCaseLawProjectionBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { storesNoCorpusDocument } from "@/api/lib/legal-search/sk-document-backfill";

/**
 * Slovak court decisions whose downloaded document was settled as having
 * nothing, and the way back into the deferred-document walk for them.
 *
 * The walk stores an empty text when a download yields no document. A parse
 * whose AST failed the strict document guard was settled the same way, so
 * its decision reads as one the publisher had nothing for. Once the parser
 * produces a document for it again, putting the decision back into the walk
 * is the whole repair: the walk fetches it again at its own pace, under its
 * own budget and cooldown, and this module sends nothing to the publisher.
 *
 * The selection is narrow on purpose. A decision qualifies only when its
 * text is blank, its stored AST carries no block (absent, empty, or not a
 * block list at all), nothing is stored for it in the corpus, it has a
 * document address, and its last fetch attempt is no older than the
 * operator's `since`. That last bound keeps decisions the publisher really
 * had nothing for, settled before the window, out of the requeue.
 */

/** Decisions one scan visits at most, so one call stays a bounded read. */
export const MAX_EMPTIED_DOCUMENT_SCAN = 50_000;

/** The AST column holds no block: absent, `{}`, or a `blocks` that is not a list. */
const storedAstHasNoBlocks = sql`coalesce(
  case
    when jsonb_typeof(${caseLawDecisions.documentAst} -> 'blocks') = 'array'
      then jsonb_array_length(${caseLawDecisions.documentAst} -> 'blocks')
  end,
  0
) = 0`;

/** A decision settled as having no document, by a fetch at or after `since`. */
const emptiedDocumentPredicate = (since: Date) =>
  and(
    isNull(caseLawDecisions.redactedAt),
    isNotNull(caseLawDecisions.documentUrl),
    isNotNull(caseLawDecisions.fulltext),
    sql`btrim(${caseLawDecisions.fulltext}) = ''`,
    storesNoCorpusDocument,
    storedAstHasNoBlocks,
    // The operator names the window to the second; cast so the comparison
    // runs at the column's own precision.
    sql`${caseLawDecisions.documentFetchAttemptedAt} >= ${since.toISOString()}::timestamptz`,
  );

export type EmptiedDocumentScan = {
  /** Decisions of the source the scan read, in id order. */
  visited: number;
  /** The last visited id: the `after` of the next scan, null when none. */
  lastVisitedId: SafeId<"caseLawDecision"> | null;
  /** The visited decisions that qualify, in id order. */
  matched: SafeId<"caseLawDecision">[];
};

export type ScanEmptiedDocumentsOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  since: Date;
  /** Resume strictly after this id; null starts at the source's first. */
  after: SafeId<"caseLawDecision"> | null;
  /** Decisions visited at most: 1 to `MAX_EMPTIED_DOCUMENT_SCAN`. */
  scan: number;
};

/**
 * The next `scan` decisions of the source in id order, read from
 * `case_law_decisions_source_id_page_idx`, and those among them that qualify.
 * The window is bounded by the visit count, not by matches, so one call reads
 * at most `scan` rows however few qualify.
 */
export const scanEmptiedDocuments = async ({
  after,
  scan,
  scopedDb,
  since,
  sourceId,
}: ScanEmptiedDocumentsOptions): Promise<EmptiedDocumentScan> => {
  if (
    !Number.isSafeInteger(scan) ||
    scan < 1 ||
    scan > MAX_EMPTIED_DOCUMENT_SCAN
  ) {
    return panic(
      `scan must be an integer from 1 to ${String(MAX_EMPTIED_DOCUMENT_SCAN)}, got ${String(scan)}`,
    );
  }
  return await scopedDb(async (tx) => {
    const window = await tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          after === null ? undefined : gt(caseLawDecisions.id, after),
        ),
      )
      .orderBy(asc(caseLawDecisions.id))
      .limit(scan);
    const ids = window.map(({ id }) => id);
    const first = ids.at(0);
    const last = ids.at(-1);
    if (first === undefined || last === undefined) {
      return { visited: 0, lastVisitedId: null, matched: [] };
    }
    const matched = await tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          gte(caseLawDecisions.id, first),
          lte(caseLawDecisions.id, last),
          emptiedDocumentPredicate(since),
        ),
      )
      .orderBy(asc(caseLawDecisions.id))
      // The window holds `scan` decisions, so no more can qualify.
      .limit(scan);
    return {
      visited: ids.length,
      lastVisitedId: last,
      matched: matched.map(({ id }) => id),
    };
  });
};

/** Each requested row has an explicit terminal outcome in the results file. */
type EmptiedDocumentRequeueOutcome =
  | { type: "requeued" }
  | { type: "no-longer-eligible" }
  | { type: "quarantined"; reason: "projection-or-update-failed" };

class EmptiedDocumentBatchError extends TaggedError(
  "EmptiedDocumentBatchError",
)<{
  message: string;
  cause: unknown;
}> {}

type EmptiedDocumentRowOutcome = {
  decisionId: SafeId<"caseLawDecision">;
  outcome: EmptiedDocumentRequeueOutcome;
};

type RequeueBatchOptions = {
  decisionIds: readonly SafeId<"caseLawDecision">[];
  since: Date;
  sourceId: SafeId<"caseLawSource">;
};

const requeueEmptiedDocumentBatchTx = async (
  tx: Transaction,
  { decisionIds, since, sourceId }: RequeueBatchOptions,
): Promise<EmptiedDocumentRowOutcome[]> => {
  const lock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
    family: "case_law",
    sourceId,
  });
  await lockCaseLawDecisionRows({ tx, decisionIds });
  const eligible = await tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        inArray(caseLawDecisions.id, [...decisionIds]),
        eq(caseLawDecisions.sourceId, sourceId),
        emptiedDocumentPredicate(since),
      ),
    )
    .orderBy(asc(caseLawDecisions.id))
    .limit(decisionIds.length);
  const ids = eligible.map(({ id }) => id);
  if (ids.length > 0) {
    await tx
      .update(caseLawDecisions)
      .set({ fulltext: null, documentFetchAttempts: 0 })
      .where(inArray(caseLawDecisions.id, ids));
    await recordCorpusWithdrawalAuditEvent(tx, {
      decisionId: ids,
      reason: "Requeue settled empty documents for deferred PDF parsing",
    });
    if (lock !== null) {
      await synchronizeLockedCaseLawProjectionBatchTx(tx, {
        lock,
        sourceId,
        decisionIds: ids,
      });
    }
  }
  const requeued = new Set(ids);
  return decisionIds.map((decisionId) => ({
    decisionId,
    outcome: {
      type: requeued.has(decisionId) ? "requeued" : "no-longer-eligible",
    },
  }));
};

/** A failed transaction releases its locks before isolating its poison row. */
const requeueIsolatedBatch = async (
  scopedDb: ScopedDb,
  options: RequeueBatchOptions,
): Promise<EmptiedDocumentRowOutcome[]> => {
  const attempted = await Result.tryPromise({
    try: async () =>
      await scopedDb(
        async (tx) => await requeueEmptiedDocumentBatchTx(tx, options),
      ),
    catch: (cause) =>
      new EmptiedDocumentBatchError({
        message: "Emptied document batch failed",
        cause,
      }),
  });
  if (attempted.isOk()) {
    return attempted.value;
  }
  const { decisionIds } = options;
  if (decisionIds.length === 1) {
    return decisionIds.map((decisionId) => ({
      decisionId,
      outcome: { type: "quarantined", reason: "projection-or-update-failed" },
    }));
  }
  const middle = Math.floor(decisionIds.length / 2);
  const left = await requeueIsolatedBatch(scopedDb, {
    ...options,
    decisionIds: decisionIds.slice(0, middle),
  });
  const right = await requeueIsolatedBatch(scopedDb, {
    ...options,
    decisionIds: decisionIds.slice(middle),
  });
  return left.concat(right);
};

/** Decisions one requeue call resets at most. */
export const MAX_EMPTIED_DOCUMENT_REQUEUE = 5000;

export type RequeueEmptiedDocumentsOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  since: Date;
  decisionIds: readonly SafeId<"caseLawDecision">[];
};

/**
 * Recheck and reset at most 32 decisions per transaction. Locks live through
 * the batch commit; a failed batch rolls back before splitting for isolation.
 * The attempt timestamp stays, preserving the publisher walk's cooldown.
 * Quarantined rows stay unchanged and are recorded by the command's sink.
 */
export const requeueEmptiedDocuments = async ({
  decisionIds,
  scopedDb,
  since,
  sourceId,
}: RequeueEmptiedDocumentsOptions): Promise<EmptiedDocumentRowOutcome[]> => {
  if (decisionIds.length > MAX_EMPTIED_DOCUMENT_REQUEUE) {
    return panic(
      `requeue takes at most ${String(MAX_EMPTIED_DOCUMENT_REQUEUE)} decisions, got ${String(decisionIds.length)}`,
    );
  }
  const uniqueIds = [...new Set(decisionIds)].toSorted();
  const outcomes: EmptiedDocumentRowOutcome[] = [];
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE
  ) {
    const batch = uniqueIds.slice(
      offset,
      offset + CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE,
    );
    outcomes.push(
      ...(await requeueIsolatedBatch(scopedDb, {
        decisionIds: batch,
        since,
        sourceId,
      })),
    );
  }
  return outcomes;
};
