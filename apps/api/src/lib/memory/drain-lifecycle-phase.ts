/**
 * Batch-drain control flow for the AI-memory lifecycle sweep.
 *
 * Extracted from the curator task so the termination guarantees below can be
 * exercised directly: the task itself only reaches them through the scheduler
 * and a live database.
 */

import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";

export type DrainMemoryLifecyclePhaseOptions<TRow> = {
  /** Rows still matching the phase predicate, capped at `batchSize`. */
  selectBatch: () => Promise<readonly { id: SafeId<"aiMemory"> }[]>;
  /** Maximum rows one batch may select. */
  batchSize: number;
  /**
   * Ceiling on batches per run. Bounds how long a single run can hold its
   * scheduler slot; the residue is picked up by the next run.
   */
  maxBatches: number;
  signal: AbortSignal;
  /** Applies the phase transition, returning the rows it actually changed. */
  transitionBatch: (
    ids: readonly SafeId<"aiMemory">[],
  ) => Promise<readonly TRow[]>;
};

/**
 * Drain one lifecycle phase batch-by-batch until the backlog is exhausted.
 *
 * A single batch per run would let a backlog outpace the sweep, so the phase
 * continues while batches keep coming back full. Three properties bound it:
 *
 *  - `maxBatches` caps the work one run may do, so a large backlog is drained
 *    across successive runs instead of holding the scheduler slot. Because
 *    the phase recurses (batches are strictly sequential, so `no-await-in-loop`
 *    rules out a plain loop), this cap is also what bounds the call depth.
 *  - It stops when a batch transitions nothing. Termination otherwise relies
 *    on `transitionBatch` mutating exactly what `selectBatch` matched; if the
 *    two predicates ever drift, it would re-select the same rows forever.
 *    Stopping on an empty transition makes termination structural instead.
 *  - It stops as soon as a batch comes back short, the normal exit.
 *
 * The abort signal is checked before every batch so a shutdown mid-drain stops
 * promptly rather than after the whole backlog.
 *
 * Returns the number of rows actually transitioned.
 */
export const drainMemoryLifecyclePhase = async <TRow>({
  batchSize,
  maxBatches,
  selectBatch,
  signal,
  transitionBatch,
}: DrainMemoryLifecyclePhaseOptions<TRow>): Promise<number> => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  if (maxBatches <= 0) {
    return 0;
  }

  const batch = await selectBatch();
  if (batch.length === 0) {
    return 0;
  }

  const transitioned = await transitionBatch(batch.map(({ id }) => id));
  // An empty transition means the predicates disagree (or a concurrent run
  // won the rows); either way, recursing would re-select the same batch.
  if (transitioned.length === 0 || batch.length < batchSize) {
    return transitioned.length;
  }

  return (
    transitioned.length +
    (await drainMemoryLifecyclePhase({
      batchSize,
      maxBatches: maxBatches - 1,
      selectBatch,
      signal,
      transitionBatch,
    }))
  );
};
