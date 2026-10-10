import { panic } from "better-result";

import { TEST_BATCH_KIND, type TestBatchKind } from "./test-batch-plan";
import { testFileDurationWeights } from "./test-timings";

export const API_TEST_LANES_ENV = "API_TEST_LANES";

/**
 * Upper bound for the derived CI lane count. Every batch is its own `bun test`
 * process, and PGlite's WASM and the garbage collector keep more than one
 * thread busy per process, so a fourth lane on a four-core runner mostly adds
 * contention instead of throughput.
 */
export const MAX_DERIVED_TEST_LANES = 3;

const BYTES_PER_MB = 1024 * 1024;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const DISABLED_FLAG_VALUES = new Set(["", "0", "false"]);

type DeriveTestLaneCountOptions = {
  availableParallelism: number;
  env: Readonly<Record<string, string | undefined>>;
  /** The largest per-batch peak-RSS budget one lane may hold at once. */
  laneMemoryBudgetMb: number;
  totalMemoryBytes: number;
};

/**
 * How many test batches run at the same time. An explicit `API_TEST_LANES`
 * wins. On CI the count follows the runner: one core stays free for the
 * runner itself, and each lane must fit the largest batch budget in physical
 * memory, so a smaller runner degrades to fewer lanes (down to serial) rather
 * than running out of memory. Local runs stay serial unless asked, keeping
 * their output streamed live.
 */
export const deriveTestLaneCount = ({
  availableParallelism,
  env,
  laneMemoryBudgetMb,
  totalMemoryBytes,
}: DeriveTestLaneCountOptions): number => {
  const explicit = env[API_TEST_LANES_ENV]?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    if (!POSITIVE_INTEGER_PATTERN.test(explicit)) {
      panic(
        `${API_TEST_LANES_ENV} must be a positive integer, received "${explicit}"`,
      );
    }
    return Number(explicit);
  }

  const ci = env["CI"]?.trim().toLowerCase();
  if (ci === undefined || DISABLED_FLAG_VALUES.has(ci)) {
    return 1;
  }

  const coreLanes = Math.floor(availableParallelism) - 1;
  const memoryLanes = Math.floor(
    totalMemoryBytes / BYTES_PER_MB / laneMemoryBudgetMb,
  );
  return Math.max(1, Math.min(MAX_DERIVED_TEST_LANES, coreLanes, memoryLanes));
};

/**
 * Heavy-logic batches carry the largest peak-RSS budget; running one at a time
 * keeps the worst concurrent footprint at one heavy budget plus ordinary ones.
 */
export const isExclusiveTestBatch = (kind: TestBatchKind): boolean =>
  kind === TEST_BATCH_KIND.heavyLogic;

type LaneBatch = { readonly kind: TestBatchKind };

/** Stable longest-expected-first order; execution constraints stay in runInLanes. */
export const orderBatchesForLanes = <
  TBatch extends LaneBatch & { readonly testFiles: readonly string[] },
>(
  batches: readonly TBatch[],
  durations: Readonly<Record<string, number>>,
): TBatch[] => {
  const weights = testFileDurationWeights(
    batches.flatMap(({ testFiles }) => testFiles),
    durations,
  );
  return batches
    .map((batch) => ({
      batch,
      seconds: batch.testFiles.reduce(
        (total, file) =>
          total +
          (weights[file] ?? panic(`Missing resolved duration for ${file}`)),
        0,
      ),
    }))
    .toSorted((left, right) => right.seconds - left.seconds)
    .map(({ batch }) => batch);
};

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
      console.error(error);
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

/**
 * The run's exit code: the first failing batch's, in start order. A run that
 * left batches unstarted without a failure was interrupted, never a pass.
 */
export const laneRunExitCode = (
  outcomes: readonly LaneOutcome<unknown>[],
): number => {
  const failureExitCode = outcomes
    .map(({ exitCode }) => exitCode)
    .find((exitCode) => exitCode !== null && exitCode !== 0);
  if (failureExitCode !== undefined && failureExitCode !== null) {
    return failureExitCode;
  }
  return outcomes.some(({ exitCode }) => exitCode === null) ? 1 : 0;
};
