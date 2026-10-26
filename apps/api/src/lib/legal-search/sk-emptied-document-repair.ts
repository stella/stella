import { panic } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { runDecisionWriteExtension } from "@/api/lib/case-law/decision-write-extension";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
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
export const emptiedDocumentPredicate = (since: Date) =>
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

/** What a requeue did with one decision. */
export type EmptiedDocumentRequeueOutcome =
  /** Its text is cleared and its attempts reset: the walk fetches it again. */
  | "requeued"
  /** It no longer qualifies (fetched, redacted or refreshed since the scan). */
  | "no-longer-eligible";

const requeueEmptiedDocumentTx = async (
  tx: Transaction,
  {
    decisionId,
    since,
    sourceId,
  }: {
    decisionId: SafeId<"caseLawDecision">;
    since: Date;
    sourceId: SafeId<"caseLawSource">;
  },
): Promise<EmptiedDocumentRequeueOutcome> => {
  const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, {
    family: "case_law",
    entityId: decisionId,
  });
  // audit: skip — operator requeue of public case-law documents; no user action
  const updated = await tx
    .update(caseLawDecisions)
    .set({ fulltext: null, documentFetchAttempts: 0 })
    .where(
      and(
        eq(caseLawDecisions.id, decisionId),
        eq(caseLawDecisions.sourceId, sourceId),
        emptiedDocumentPredicate(since),
      ),
    )
    .returning({ id: caseLawDecisions.id });
  if (updated.length === 0) {
    return "no-longer-eligible";
  }
  if (projectionLock !== null) {
    await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
      lock: projectionLock,
      subject: { family: "case_law", entityId: decisionId },
    });
  }
  await runDecisionWriteExtension(tx, decisionId);
  return "requeued";
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
 * Put each listed decision back into the walk, one short transaction per
 * decision, re-checking the selection in its own update. A decision already
 * fetched, or requeued by an earlier run, no longer qualifies and is reported
 * as such, so running the same list twice requeues it once.
 *
 * The text becomes NULL, which is what the walk reads as "not fetched yet",
 * and the attempt count returns to zero. The last attempt's timestamp stays,
 * so a requeued decision waits out one base cooldown rather than arriving at
 * the head of the queue in a burst.
 */
export const requeueEmptiedDocuments = async ({
  decisionIds,
  scopedDb,
  since,
  sourceId,
}: RequeueEmptiedDocumentsOptions): Promise<
  {
    decisionId: SafeId<"caseLawDecision">;
    outcome: EmptiedDocumentRequeueOutcome;
  }[]
> => {
  if (decisionIds.length > MAX_EMPTIED_DOCUMENT_REQUEUE) {
    return panic(
      `requeue takes at most ${String(MAX_EMPTIED_DOCUMENT_REQUEUE)} decisions, got ${String(decisionIds.length)}`,
    );
  }
  const outcomes: {
    decisionId: SafeId<"caseLawDecision">;
    outcome: EmptiedDocumentRequeueOutcome;
  }[] = [];
  for (const decisionId of decisionIds) {
    const outcome = await scopedDb(
      async (tx) =>
        await requeueEmptiedDocumentTx(tx, { decisionId, since, sourceId }),
    );
    outcomes.push({ decisionId, outcome });
  }
  return outcomes;
};
