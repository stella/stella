import { panic } from "better-result";

import { printError } from "@stll/errors";

import { TEST_BATCH_KIND, type TestBatchKind } from "./test-batch-plan";

/**
 * Heavy batches carry the largest peak-RSS budget; running one at a time
 * keeps the worst concurrent footprint at one heavy budget plus ordinary ones.
 */
export const isExclusiveTestBatch = (kind: TestBatchKind): boolean =>
  kind === TEST_BATCH_KIND.heavyLogic || kind === TEST_BATCH_KIND.heavyDb;

type LaneBatch = { readonly kind: TestBatchKind };

export type LaneOutcome<TBatch> = {
  readonly batch: TBatch;
  /** `null` when the batch never started: see `runInLanes`. */
  readonly exitCode: number | null;
};

type RunInLanesOptions<TBatch extends LaneBatch> = {
  /** Already in start order; outcomes come back in this same order. */
  batches: readonly TBatch[];
  lanes: number;
  /** Resolves with the batch's exit code; a rejection counts as exit 1. */
  runBatch: (batch: TBatch, lane: number) => Promise<number>;
  /** Once aborted, no further batch starts; running ones finish. */
  signal?: AbortSignal | undefined;
  failurePolicy?: "serial-fast" | "complete";
};

/**
 * Run the batches with at most `lanes` in flight and at most one exclusive
 * batch among them. With several lanes a failure never stops the remaining
 * batches, so one run reports every failing batch. A single lane stops at the
 * first failure instead, the quick feedback a serial local run wants. Outcomes
 * come back in start order regardless of completion order.
 */
export const runInLanes = async <TBatch extends LaneBatch>({
  batches,
  lanes,
  runBatch,
  signal,
  failurePolicy = "serial-fast",
}: RunInLanesOptions<TBatch>): Promise<LaneOutcome<TBatch>[]> => {
  if (!Number.isInteger(lanes) || lanes < 1) {
    panic("test lane count must be a positive integer");
  }

  const stopAtFirstFailure = failurePolicy === "serial-fast" && lanes === 1;
  const exitCodes: (number | null)[] = batches.map(() => null);
  const pending = batches.map((batch, index) => ({ batch, index }));
  let failed = false;
  let exclusiveRunning = false;
  // Lanes that find only exclusive batches left while one is running park
  // here until a batch settles.
  let parkedLanes: (() => void)[] = [];
  const wakeParkedLanes = () => {
    const woken = parkedLanes;
    parkedLanes = [];
    for (const wake of woken) {
      wake();
    }
  };

  const runBatchSafely = async (
    batch: TBatch,
    lane: number,
  ): Promise<number> => {
    try {
      return await runBatch(batch, lane);
    } catch (error) {
      printError(error);
      return 1;
    }
  };

  const runLane = async (lane: number): Promise<void> => {
    if (
      pending.length === 0 ||
      signal?.aborted === true ||
      (stopAtFirstFailure && failed)
    ) {
      return;
    }
    const nextPosition = pending.findIndex(
      ({ batch }) => !(exclusiveRunning && isExclusiveTestBatch(batch.kind)),
    );
    if (nextPosition === -1) {
      // Only exclusive batches remain and one of them holds another lane,
      // which wakes this one when it settles.
      await new Promise<void>((resolve) => {
        parkedLanes.push(resolve);
      });
      await runLane(lane);
      return;
    }
    const [next] = pending.splice(nextPosition, 1);
    if (next === undefined) {
      return;
    }
    const exclusive = isExclusiveTestBatch(next.batch.kind);
    exclusiveRunning ||= exclusive;
    const exitCode = await runBatchSafely(next.batch, lane);
    exitCodes[next.index] = exitCode;
    failed ||= exitCode !== 0;
    if (exclusive) {
      exclusiveRunning = false;
    }
    wakeParkedLanes();
    await runLane(lane);
  };

  await Promise.all(
    Array.from(
      { length: Math.min(lanes, batches.length) },
      async (_, index) => await runLane(index + 1),
    ),
  );

  return batches.map((batch, index) => ({
    batch,
    exitCode: exitCodes.at(index) ?? null,
  }));
};
