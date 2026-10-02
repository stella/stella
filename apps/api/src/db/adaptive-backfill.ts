import { Result } from "better-result";

import {
  decideStart,
  defaultConfig,
  nextBatch,
} from "@stll/db-load-gate/health";
import type {
  BatchState,
  HealthConfig,
  Verdict,
} from "@stll/db-load-gate/health";

import { commitReplaySafeIngestionBatch } from "../lib/replay-safe-ingestion";
import type { IngestionTransactionRunner } from "../lib/replay-safe-ingestion";

export type BackfillCheckpoint<Cursor> = { cursor: Cursor; batch: BatchState };
type BackfillPage<Item, Cursor> = {
  items: readonly Item[];
  cursor: Cursor;
  done: boolean;
};
type AdaptiveBackfillOptions<Transaction, Item, Cursor> = {
  runInTransaction: IngestionTransactionRunner<Transaction>;
  /** Lock the owning checkpoint row before reading it. */
  readCheckpoint: (tx: Transaction) => Promise<BackfillCheckpoint<Cursor>>;
  persistCheckpoint: (
    tx: Transaction,
    state: BackfillCheckpoint<Cursor>,
  ) => Promise<void>;
  /** Select in key order with row locks; include every scanned row in the cursor. */
  selectPage: (
    tx: Transaction,
    cursor: Cursor,
    size: number,
  ) => Promise<BackfillPage<Item, Cursor>>;
  needsWork: (item: Item) => boolean;
  persistItems: (
    tx: Transaction,
    items: readonly Item[],
  ) => void | Promise<void>;
  readVerdict: () => Promise<Verdict>;
  slot: {
    tryAcquire: (tx: Transaction) => Promise<boolean>;
    release: () => void | Promise<void>;
  };
  clock: () => number;
  log: (record: unknown) => void;
  isStatementTimeout?: (cause: unknown) => boolean;
  config?: HealthConfig;
};

/** One invocation performs at most one batch; holds return durably, without polling. */
export const runAdaptiveBackfillBatch = async <Transaction, Item, Cursor>({
  runInTransaction,
  readCheckpoint,
  persistCheckpoint,
  selectPage,
  needsWork,
  persistItems,
  readVerdict,
  slot,
  clock,
  log,
  isStatementTimeout = () => false,
  config = defaultConfig,
}: AdaptiveBackfillOptions<Transaction, Item, Cursor>) => {
  // Metric I/O precedes the transaction and never holds row locks.
  const reading = await Result.tryPromise(readVerdict);
  const verdict: Verdict = Result.isOk(reading)
    ? reading.value
    : {
        kind: "unknown",
        signals: [
          {
            indicator: "ebs_balance",
            kind: "unknown",
            value: null,
            threshold: null,
            observedAt: null,
            reason: "Metric reader failed",
          },
        ],
      };
  const start = decideStart(verdict, "backfill_batch", config);
  log(start);
  const slotState = { acquired: false };
  try {
    const outcome = await Result.tryPromise(
      async () =>
        await runInTransaction(async (tx) => {
          const checkpoint = await readCheckpoint(tx);
          if (
            checkpoint.batch.holdUntil !== null &&
            checkpoint.batch.holdUntil > clock()
          ) {
            log({ action: "hold", ...checkpoint.batch, verdict, config });
            return {
              status: "held" as const,
              verdict,
              checkpoint,
              scanned: 0,
              written: 0,
            };
          }
          slotState.acquired =
            start.decision === "start" && (await slot.tryAcquire(tx));
          const effectiveVerdict: Verdict =
            slotState.acquired || start.decision === "wait"
              ? verdict
              : {
                  kind: "unknown",
                  signals: [
                    ...verdict.signals,
                    {
                      indicator: "long_transaction",
                      kind: "unknown",
                      value: null,
                      threshold: null,
                      observedAt: new Date(clock()).toISOString(),
                      reason: "Heavy work slot unavailable",
                    },
                  ],
                };
          const decision = nextBatch({
            state: checkpoint.batch,
            verdict: effectiveVerdict,
            lastDurationMs: null,
            config,
            clock,
          });
          log(decision);
          if (decision.action === "hold") {
            const held = { cursor: checkpoint.cursor, batch: decision.state };
            await persistCheckpoint(tx, held);
            return {
              status: "held" as const,
              verdict: effectiveVerdict,
              checkpoint: held,
              scanned: 0,
              written: 0,
            };
          }
          const began = clock();
          const page = await selectPage(tx, checkpoint.cursor, decision.size);
          const items = page.items.filter(needsWork);
          let committed = { cursor: page.cursor, batch: decision.state };
          await commitReplaySafeIngestionBatch({
            items,
            checkpoint: page.cursor,
            runInTransaction: async (work) => await work(tx),
            persistItems,
            persistCheckpoint: async (transaction, cursor) => {
              const completed = nextBatch({
                // Sizing uses the pre-batch numbers once; the accepted batch
                // already cleared its hold. A reading aging during committed
                // work cannot retroactively hold that successful batch.
                state: {
                  size: checkpoint.batch.size,
                  sleepMs: checkpoint.batch.sleepMs,
                  smoothedDurationMs: checkpoint.batch.smoothedDurationMs,
                  stableBatches: checkpoint.batch.stableBatches,
                  holdCount: decision.state.holdCount,
                  heldSince: decision.state.heldSince,
                  holdUntil: decision.state.holdUntil,
                  holdCause: decision.state.holdCause,
                },
                verdict,
                lastDurationMs: Math.max(0, clock() - began),
                config,
                clock,
              });
              log(completed);
              committed = { cursor, batch: completed.state };
              await persistCheckpoint(transaction, committed);
            },
          });
          return {
            status: page.done ? ("done" as const) : ("advanced" as const),
            verdict,
            checkpoint: committed,
            scanned: page.items.length,
            written: items.length,
          };
        }),
    );
    if (Result.isOk(outcome)) {
      return outcome.value;
    }
    if (!isStatementTimeout(outcome.error)) {
      throw outcome.error;
    }
    // The failed transaction rolled back the writes and cursor. Persist only
    // the timeout adjustment, then return so the scheduler retries that range.
    return await runInTransaction(async (tx) => {
      const checkpoint = await readCheckpoint(tx);
      const retry = nextBatch({
        state: checkpoint.batch,
        verdict,
        lastDurationMs: null,
        outcome: "statement_timeout",
        config,
        clock,
      });
      log(retry);
      const held = { cursor: checkpoint.cursor, batch: retry.state };
      await persistCheckpoint(tx, held);
      return {
        status: "retry" as const,
        verdict,
        checkpoint: held,
        scanned: 0,
        written: 0,
      };
    });
  } finally {
    if (slotState.acquired) {
      await slot.release();
    }
  }
};
