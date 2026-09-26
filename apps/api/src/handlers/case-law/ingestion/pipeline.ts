import { Result, panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { caseLawSources } from "@/api/db/schema";
import {
  ADAPTER_TIMEOUT,
  MAX_SYNC_PAGES,
} from "@/api/handlers/case-law/consts";
import type { SyncPage } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  applyDecisionBatch,
  MAX_CONSECUTIVE_FAILURES,
  recordIngestionFailures,
} from "@/api/handlers/case-law/ingestion/pipeline/batch";
import type {
  DecisionBatchHalt,
  FailureLedgerWrite,
  IngestionFailureRow,
} from "@/api/handlers/case-law/ingestion/pipeline/batch";
import { partitionWithinBatchBounds } from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import { CASE_LAW_CORPUS_DEPENDENCIES } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import {
  wrappedErrorDetail,
  PROCESS_DECISION_STATUS,
  PROCESS_DECISION_RETRY_REASON,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { readStoredRawFromS3 } from "@/api/handlers/case-law/ingestion/pipeline/stored-raw";
import { processSupplement } from "@/api/handlers/case-law/ingestion/pipeline/supplement";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { refreshSourceStoredTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import { captureError } from "@/api/lib/analytics/capture";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import {
  ConcurrentModificationError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  canStartCyclePage,
  remainingCycleMs,
  startCycleDeadline,
} from "@/api/lib/legal-search/cycle-deadline";
import type { StartCycleDeadlineOptions } from "@/api/lib/legal-search/cycle-deadline";
import { logger } from "@/api/lib/observability/logger";
import { pgErrorFields } from "@/api/lib/pg-error";

type DbSlot = {
  acquire: (signal?: AbortSignal) => Promise<void>;
  release: () => void;
};

type PipelineInput = {
  source: typeof caseLawSources.$inferSelect;
  sourceLease: CaseLawSourceIngestionLease;
  scopedDb: ScopedDb;
  /**
   * The cycle's time budget, and the signals that end it early. The loop
   * starts a page only while enough of the budget is left for the page to
   * finish, and stops when it is exhausted. Absent in tests and bounded
   * sample runs, which stop on their own page and decision caps.
   */
  cycle?: StartCycleDeadlineOptions;
  /**
   * Hard caps for bounded sample runs (staging smoke): stop after this
   * many pages / newly stored decisions without advancing the cursor
   * past unprocessed work. Dedup-skipped and failed decisions do not
   * count toward the cap, so a re-run with the same cap continues past
   * already-ingested work. Defaults to the adapter's own cycle limits.
   */
  maxPages?: number;
  maxDecisions?: number;
  /**
   * Optional concurrency limiter for DB-heavy operations.
   * When provided, the pipeline acquires a slot before
   * processing decisions (insert, index, citations) and
   * releases it before the next page fetch. This lets
   * external API fetches run in parallel across adapters
   * while capping concurrent DB pressure.
   */
  dbSlot?: DbSlot;
  corpus?: CaseLawCorpusDependencies;
};

type PipelineResult = {
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  s3UploadFailures: number;
  pagesProcessed: number;
  nextCursor: string | null;
  /** Non-null if the adapter was halted early due to repeated failures. */
  haltReason: string | null;
};

/**
 * Halt reasons the operator loop classifies on. The runner reads the timeout
 * one to separate a cycle that ran out of budget from one that failed, so the
 * text is a shared constant rather than a literal on both sides.
 */
export const CYCLE_HALT_REASON = {
  TIMEOUT: "Cycle timeout exceeded",
} as const;

const databaseTimeoutHaltReason = (error: TimeoutError): string =>
  `Database timeout; cursor held for retry: ${error.message.slice(0, 200)}`;

/**
 * What a failure-ledger write means for the cursor. A timeout or a transient
 * database condition holds it and the page is read again. A rejection
 * repeats on a replay of the same rows, so it is reported and the page moves
 * on.
 */
const failureLedgerHaltReason = (write: FailureLedgerWrite): string | null => {
  switch (write.type) {
    case "written":
    case "rejected":
      return null;
    case "timeout":
      return databaseTimeoutHaltReason(write.error);
    case "transient":
      return `${write.count} failure record(s) not written; cursor held for retry`;
    default:
      write satisfies never;
      return panic(`Unhandled ledger write: ${String(write)}`);
  }
};

const RETRY_HALT_REASON = {
  [PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE]:
    "1 corpus write failure(s); cursor held for retry",
  [PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE]:
    "1 source raw write failure(s); cursor held for retry",
  [PROCESS_DECISION_RETRY_REASON.CONTENTION]:
    "Concurrent decision reconciliation; cursor held for retry",
} as const satisfies Record<
  (typeof PROCESS_DECISION_RETRY_REASON)[keyof typeof PROCESS_DECISION_RETRY_REASON],
  string
>;

/** The halt reason a stopped batch leaves on its page. */
const batchHaltReason = (
  stop: DecisionBatchHalt,
  maxDecisions: number | undefined,
): string => {
  switch (stop.type) {
    case "retryable":
      return RETRY_HALT_REASON[stop.reason];
    case "timeout":
      return databaseTimeoutHaltReason(stop.error);
    case "insert-limit":
      // Halting (instead of breaking quietly) keeps the cursor at this page
      // so the unprocessed remainder is not skipped.
      return `Decision cap (${String(maxDecisions)}) reached`;
    case "failure-streak":
      return (
        `${MAX_CONSECUTIVE_FAILURES} consecutive failures; ` +
        `last: [${stop.tag}] ${stop.message.slice(0, 200)}`
      );
    case "aborted":
      return panic("A crawl batch carries no abort signal");
    default:
      stop satisfies never;
      return panic(`Unhandled batch stop: ${String(stop)}`);
  }
};

/** What a page asks the database to write: its decisions and supplements. */
const pageItemCount = ({ decisions, supplements }: SyncPage): number =>
  decisions.length + (supplements?.length ?? 0);

const PAGE_SLOT = {
  HELD: "held",
  NOT_NEEDED: "not-needed",
  /** The cycle ended while the page waited for the slot. */
  CYCLE_ENDED: "cycle-ended",
} as const;

type PageSlot = (typeof PAGE_SLOT)[keyof typeof PAGE_SLOT];

/**
 * Run the ingestion pipeline for a configured source.
 *
 * Fetches pages from the source adapter, processes each
 * decision (segment, extract citations, dedup), and stores
 * results in the database.
 */
export const runIngestionPipeline = async ({
  source,
  sourceLease,
  scopedDb,
  cycle,
  maxPages: maxPagesOverride,
  maxDecisions,
  dbSlot,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
}: PipelineInput): Promise<PipelineResult> => {
  const adapter = getAdapter(source.adapterKey);

  if (!adapter) {
    panic(`Unknown adapter: ${source.adapterKey}`);
  }

  // Started here rather than passed in, so the budget the loop measures a page
  // against is the same one the abort it would get is derived from.
  const deadline = cycle === undefined ? undefined : startCycleDeadline(cycle);

  let cursor = source.syncCursor;
  let inserted = 0;
  let skipped = 0;
  let searchVectorFailures = 0;
  let s3UploadFailures = 0;
  let pagesProcessed = 0;
  /** Track recent cursors to detect parking (stagnation or ping-pong). */
  const recentCursors = new Set<string | null>();
  /**
   * Consecutive decision-level failures. Reset on each success.
   * If this reaches the batch threshold, the adapter is halted for
   * this cycle to avoid hammering a broken court API.
   */
  let consecutiveFailures = 0;
  let haltReason: string | null = null;
  let checkpointObservationOrder = source.checkpointObservationOrder;
  /**
   * Compiled polarity rules for this cycle. One read per language the cycle
   * meets, rather than one per decision; a rule edited mid-cycle lands on the
   * next one, which is the same bargain the background classifier makes.
   */
  const polarityRules: RuleCache = new Map();

  const maxPages = maxPagesOverride ?? adapter.maxSyncPages ?? MAX_SYNC_PAGES;
  const pageTimeout = adapter.pageTimeoutMs ?? ADAPTER_TIMEOUT.PAGE;

  const fetchObservedPage = async (
    fetchCursor: string | null,
    pageSignal: AbortSignal,
  ) =>
    await Result.tryPromise({
      try: async () =>
        await sourceLease.beforeRemoteEffect(async () => {
          // The lease renewal this callback runs behind spends budget of its
          // own, so the page admitted a moment ago may no longer fit. This is
          // the last point before the request where that can still be read.
          if (deadline && !canStartCyclePage(deadline, pageTimeout)) {
            return { type: "budget-exhausted" } as const;
          }
          const pageResult = await adapter.fetchPage(
            fetchCursor,
            source.config ?? {},
            pageSignal,
          );
          if (Result.isError(pageResult)) {
            return { error: pageResult.error, type: "fetch-error" } as const;
          }
          return {
            observationOrder: await allocateSourceObservationOrder({
              leaseToken: sourceLease.leaseToken,
              scopedDb,
              sourceId: source.id,
            }),
            page: pageResult.value,
            type: "fetched",
          } as const;
        }),
      catch: (cause) => cause,
    });

  const cycleTimeoutHalt = () => {
    logger.warn("case_law.ingestion.cycle_timeout", {
      adapterKey: adapter.key,
      cursor: cursor ?? "",
      pagesProcessed,
      inserted,
      skipped,
      remainingMs: deadline ? Math.round(remainingCycleMs(deadline)) : 0,
      pageTimeoutMs: pageTimeout,
    });
    return { type: "halt", reason: CYCLE_HALT_REASON.TIMEOUT } as const;
  };

  const fetchNextObservedPage = async () => {
    // Starting a page the remaining budget cannot cover buys nothing: the
    // cycle deadline aborts it mid-flight, its work is discarded and the
    // cycle is reported as an adapter failure instead of a timeout. Stop on
    // the last completed page, which is where the cursor already stands, and
    // spend no lease renewal on the attempt.
    if (deadline && !canStartCyclePage(deadline, pageTimeout)) {
      return cycleTimeoutHalt();
    }
    const pageSignal = deadline
      ? AbortSignal.any([deadline.signal, AbortSignal.timeout(pageTimeout)])
      : AbortSignal.timeout(pageTimeout);
    recentCursors.add(cursor);
    const observedPageResult = await fetchObservedPage(cursor, pageSignal);
    if (Result.isError(observedPageResult)) {
      if (observedPageResult.error instanceof TimeoutError) {
        return {
          type: "halt",
          reason: databaseTimeoutHaltReason(observedPageResult.error),
        } as const;
      }
      if (observedPageResult.error instanceof Error) {
        throw observedPageResult.error;
      }
      throw new ConcurrentModificationError({
        message: "Case-law source observation failed",
      });
    }
    if (observedPageResult.value.type === "budget-exhausted") {
      return cycleTimeoutHalt();
    }
    if (observedPageResult.value.type === "fetch-error") {
      // Expected operational failure: record one halt in the event/log path;
      // the runner, rather than every attempt, captures sustained stalls.
      const reason = `Page fetch failed: ${observedPageResult.value.error.message}`;
      logger.error("case_law.ingestion.adapter_halted", {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
        httpStatus: String(observedPageResult.value.error.httpStatus ?? ""),
        reason,
        inserted,
        skipped,
      });
      return { type: "halt", reason } as const;
    }
    return observedPageResult.value;
  };

  /**
   * Write a page's supplement failures in one insert. Returns a halt reason
   * when the write meets a timeout or a transient database condition.
   */
  const flushIngestionFailures = async (
    failures: readonly IngestionFailureRow[],
  ): Promise<string | null> =>
    failureLedgerHaltReason(
      await recordIngestionFailures({
        scopedDb,
        failures,
        adapterKey: adapter.key,
      }),
    );

  const reparseStoredRaw = adapter.reparseStoredRaw;
  const nextObservationOrder = async (): Promise<bigint> => {
    await sourceLease.beforeDatabaseMark();
    return await allocateSourceObservationOrder({
      leaseToken: sourceLease.leaseToken,
      scopedDb,
      sourceId: source.id,
    });
  };

  /**
   * Acquire the DB slot before processing a page's items (DB-heavy: insert,
   * search index, citation extraction).
   *
   * A page with no decisions never touches the slot: it has no DB
   * work, and acquiring anyway let a cycle-timeout abort land in
   * the gap between the fetch returning and the acquire — breaking
   * out before the cursor advance below ever ran, silently
   * discarding the forward progress the fetch had already made and
   * pinning the adapter to the same cursor on every later cycle.
   */
  const acquirePageSlot = async (page: SyncPage): Promise<PageSlot> => {
    if (!dbSlot || pageItemCount(page) === 0) {
      return PAGE_SLOT.NOT_NEEDED;
    }
    try {
      await dbSlot.acquire(deadline?.signal);
      return PAGE_SLOT.HELD;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return PAGE_SLOT.CYCLE_ENDED;
      }
      throw error;
    }
  };

  /**
   * Apply a page's decisions in bounded batches, each settled before the
   * next starts. Every batch carries the page's one observation; the first
   * that stops ends the page with its halt reason, and the cursor holds.
   */
  const applyPageDecisions = async ({
    decisions,
    observation,
  }: {
    decisions: SyncPage["decisions"];
    observation: { order: bigint; observedAt: Date };
  }): Promise<string | null> => {
    for (const batch of partitionWithinBatchBounds(decisions)) {
      // db-await-in-loop: one bounded batch at a time, each settled before the next, ordered per observation
      const applied = await applyDecisionBatch({
        decisions: batch,
        sourceId: source.id,
        scopedDb,
        observation,
        refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
        corpus,
        polarityRules,
        context: { adapterKey: adapter.key, cursor },
        failureStreak: consecutiveFailures,
        insertLimit:
          maxDecisions === undefined ? undefined : maxDecisions - inserted,
      });
      inserted += applied.inserted;
      skipped += applied.skipped;
      searchVectorFailures += applied.searchVectorFailures;
      s3UploadFailures += applied.corpusWriteFailures;
      consecutiveFailures = applied.failureStreak;
      // A reason the batch stopped for wins over the ledger write's own.
      const batchHalt =
        (applied.halt === null
          ? null
          : batchHaltReason(applied.halt, maxDecisions)) ??
        failureLedgerHaltReason(applied.failureLedger);
      if (batchHalt !== null) {
        return batchHalt;
      }
    }
    return null;
  };

  /**
   * Place a page's supplements, one at a time, unless the page already
   * halted. Returns the page's halt reason: the one it came with, or one
   * naming a supplement that could not be placed, so the cursor holds and the
   * page is read again.
   */
  const placePageSupplements = async ({
    supplements,
    halted,
  }: {
    supplements: SyncPage["supplements"];
    halted: string | null;
  }): Promise<string | null> => {
    if (halted !== null || supplements === undefined) {
      return halted;
    }
    if (reparseStoredRaw === undefined) {
      return panic(
        `Adapter ${adapter.key} emits supplements but cannot rebuild the judgments they join`,
      );
    }
    const failures: IngestionFailureRow[] = [];
    for (const supplement of supplements) {
      const placed = await Result.tryPromise({
        try: async () =>
          // db-await-in-loop: each supplement locks its docket and may rewrite its judgment, ordered per observation
          await processSupplement({
            supplement,
            sourceId: source.id,
            scopedDb,
            observedAt: new Date(),
            nextObservationOrder,
            reparseStoredRaw,
            readStoredRaw: readStoredRawFromS3,
            corpus,
            polarityRules,
          }),
        catch: (cause) => cause,
      });
      if (Result.isError(placed)) {
        // As a decision's failure is: recorded and stepped over, so one
        // poison supplement cannot pin the source. It is not lost: nothing
        // holds its identity, so the reconciliation lists it again.
        const { error } = placed;
        const { document } = supplement;
        logger.error("case_law.ingestion.supplement_failed", {
          adapterKey: adapter.key,
          caseNumber: document.caseNumber,
          sourceDocumentId: document.sourceDocumentId,
          ...errorSystemFields(error),
          ...pgErrorFields(error),
          "error.detail": wrappedErrorDetail(error),
        });
        captureError(error, {
          adapterKey: adapter.key,
          step: "runIngestionPipeline.processSupplement",
        });
        if (error instanceof TimeoutError) {
          // db-await-in-loop: runs once, as the loop returns; it writes the collected failures in one insert
          await flushIngestionFailures(failures);
          return databaseTimeoutHaltReason(error);
        }
        failures.push({
          sourceId: source.id,
          caseNumber: document.caseNumber,
          language: document.language,
          errorType: errorTag(error).slice(0, 128),
          errorMessage: wrappedErrorDetail(error).slice(0, 2048),
          cursor,
        });
        continue;
      }
      if (placed.value.status === PROCESS_DECISION_STATUS.RETRYABLE) {
        // db-await-in-loop: runs once, as the loop returns; it writes the collected failures in one insert
        await flushIngestionFailures(failures);
        return `Supplement ${supplement.document.sourceDocumentId} not placed (${placed.value.reason}); cursor held for retry`;
      }
    }
    return await flushIngestionFailures(failures);
  };

  while (pagesProcessed < maxPages) {
    const observedPage = await fetchNextObservedPage();
    if (observedPage.type === "halt") {
      haltReason = observedPage.reason;
      break;
    }

    // Order the observation after the source response exists. A request-start
    // token can invert two overlapping responses and make an older payload
    // dominate a newer one. The source lease prevents those fetches from
    // overlapping; this durable token orders the resulting database writes.
    const { observationOrder, page } = observedPage;
    checkpointObservationOrder = observationOrder;
    const observedAt = new Date();

    // Released before the next page fetch so external API calls don't hold
    // the slot. try-finally ensures no slot leak on unexpected exceptions.
    const pageSlot = await acquirePageSlot(page);
    if (pageSlot === PAGE_SLOT.CYCLE_ENDED) {
      haltReason = CYCLE_HALT_REASON.TIMEOUT;
      break;
    }
    const pageT0 = performance.now();
    const insertedBefore = inserted;
    const skippedBefore = skipped;
    const s3FailuresBefore = s3UploadFailures;
    try {
      // db-await-in-loop: one bounded application pass per page, before its supplements and the cursor advance
      haltReason = await applyPageDecisions({
        decisions: page.decisions,
        observation: { order: observationOrder, observedAt },
      });

      // After the page's packs are flushed, so a judgment written on this
      // page is settled before its supplement writes it again, and before the
      // cursor moves, so a supplement that could not be placed holds it.
      // db-await-in-loop: one placement pass per page, after the page's pack is flushed and before the cursor moves
      haltReason = await placePageSupplements({
        supplements: page.supplements,
        halted: haltReason,
      });

      const pageInserted = inserted - insertedBefore;
      const pageSkipped = skipped - skippedBefore;
      const pageS3Failures = s3UploadFailures - s3FailuresBefore;
      if (pageS3Failures > 0 && haltReason === null) {
        // Hold the cursor on a page with failed corpus writes: cursor
        // sources do not re-emit consumed pages, so advancing would leave
        // the preserved source-hash retry unreachable until the source
        // changes again.
        haltReason = `${pageS3Failures} corpus write failure(s); cursor held for retry`;
      }
      logger.info("case_law.ingestion.pipeline_page_done", {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
        nextCursor: page.nextCursor ?? "",
        page: pagesProcessed + 1,
        decisions: page.decisions.length,
        inserted: pageInserted,
        skipped: pageSkipped,
        durationMs: Math.round(performance.now() - pageT0),
        halted: haltReason !== null,
      });

      if (haltReason) {
        logger.error("case_law.ingestion.adapter_halted", {
          adapterKey: adapter.key,
          cursor: cursor ?? "",
          reason: haltReason,
          inserted,
          skipped,
        });
        break;
      }

      cursor = page.nextCursor;
      pagesProcessed++;
    } finally {
      if (dbSlot && pageSlot === PAGE_SLOT.HELD) {
        dbSlot.release();
      }
    }

    // Stop when the adapter signals exhaustion: null cursor
    // or a cursor we've already visited (stagnation / ping-pong
    // between two parked positions).
    if (!page.nextCursor || recentCursors.has(page.nextCursor)) {
      break;
    }

    if (adapter.minRequestIntervalMs > 0) {
      await Bun.sleep(adapter.minRequestIntervalMs);
    }
  }

  await sourceLease.beforeDatabaseMark();
  const checkpoint = await advanceCorpusIngestionCheckpoint({
    expectedCursor: source.syncCursor,
    nextCursor: cursor,
    scopedDb,
    source: {
      id: source.id,
      leaseToken: sourceLease.leaseToken,
      observationOrder: checkpointObservationOrder,
      type: CORPUS_SOURCE_TYPE.CASE_LAW,
    },
  });
  if (checkpoint.status === INGESTION_CHECKPOINT_STATUS.MISSING) {
    return panic("Case-law ingestion source disappeared before checkpoint");
  }
  if (checkpoint.status === INGESTION_CHECKPOINT_STATUS.SUPERSEDED) {
    logger.warn("case_law.ingestion.checkpoint_superseded", {
      adapterKey: source.adapterKey,
      sourceId: source.id,
    });
  }
  cursor = checkpoint.cursor;

  // After the checkpoint and outside its transaction: the count walks the
  // source's whole index range, and holding the leased source row's
  // transaction open for it would block the next cycle on bookkeeping. It
  // rate-limits itself to one count per source per interval and reports its
  // own failures, so its outcome never reaches this run's result.
  await refreshSourceStoredTotal({
    scopedDb,
    sourceId: source.id,
    now: new Date(),
  });

  return {
    inserted,
    skipped,
    searchVectorFailures,
    s3UploadFailures,
    pagesProcessed,
    nextCursor: cursor,
    haltReason,
  };
};
