import { panic } from "better-result";

import { TEST_BATCH_KIND, type TestBatchKind } from "./test-batch-plan";

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
 * Start order across batch kinds, longest expected work first so the last
 * batches to finish are short ones and the lanes drain together. DB batches
 * boot PGlite per file and module-mock batches run under `--isolate`; both
 * take several times longer per process than a logic batch.
 */
const LANE_START_PRIORITY = {
  [TEST_BATCH_KIND.db]: 0,
  [TEST_BATCH_KIND.moduleMock]: 1,
  [TEST_BATCH_KIND.heavyLogic]: 2,
  [TEST_BATCH_KIND.regular]: 3,
} as const satisfies Record<TestBatchKind, number>;

/**
 * Heavy-logic batches carry the largest peak-RSS budget; running one at a time
 * keeps the worst concurrent footprint at one heavy budget plus ordinary ones.
 */
export const isExclusiveTestBatch = (kind: TestBatchKind): boolean =>
  kind === TEST_BATCH_KIND.heavyLogic;

type LaneBatch = { readonly kind: TestBatchKind };

/** Stable: batches of one kind keep their planned order. */
export const orderBatchesForLanes = <TBatch extends LaneBatch>(
  batches: readonly TBatch[],
): TBatch[] =>
  batches.toSorted(
    (left, right) =>
      LANE_START_PRIORITY[left.kind] - LANE_START_PRIORITY[right.kind],
  );

export type LaneOutcome<TBatch> = {
  readonly batch: TBatch;
  readonly exitCode: number;
};

type RunInLanesOptions<TBatch extends LaneBatch> = {
  /** Already in start order; outcomes come back in this same order. */
  batches: readonly TBatch[];
  lanes: number;
  /** Resolves with the batch's exit code; a rejection counts as exit 1. */
  runBatch: (batch: TBatch) => Promise<number>;
};

/**
 * Run every batch with at most `lanes` in flight and at most one exclusive
 * batch among them. A failure never stops the remaining batches, so one run
 * reports every failing batch; outcomes are returned in start order regardless
 * of completion order.
 */
export const runInLanes = async <TBatch extends LaneBatch>({
  batches,
  lanes,
  runBatch,
}: RunInLanesOptions<TBatch>): Promise<LaneOutcome<TBatch>[]> => {
  if (!Number.isInteger(lanes) || lanes < 1) {
    panic("test lane count must be a positive integer");
  }

  const exitCodes: (number | undefined)[] = batches.map(() => undefined);
  const pending = batches.map((batch, index) => ({ batch, index }));
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

  const runBatchSafely = async (batch: TBatch): Promise<number> => {
    try {
      return await runBatch(batch);
    } catch (error) {
      console.error(error);
      return 1;
    }
  };

  const runLane = async (): Promise<void> => {
    if (pending.length === 0) {
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
      return await runLane();
    }
    const [next] = pending.splice(nextPosition, 1);
    if (next === undefined) {
      return;
    }
    const exclusive = isExclusiveTestBatch(next.batch.kind);
    exclusiveRunning ||= exclusive;
    exitCodes[next.index] = await runBatchSafely(next.batch);
    if (exclusive) {
      exclusiveRunning = false;
    }
    wakeParkedLanes();
    return await runLane();
  };

  await Promise.all(
    Array.from(
      { length: Math.min(lanes, batches.length) },
      async () => await runLane(),
    ),
  );

  return batches.map((batch, index) => ({
    batch,
    exitCode: exitCodes.at(index) ?? panic(`test batch ${index} never settled`),
  }));
};

/** The run's exit code: the first failing batch's, in start order. */
export const laneRunExitCode = (
  outcomes: readonly LaneOutcome<unknown>[],
): number => outcomes.find(({ exitCode }) => exitCode !== 0)?.exitCode ?? 0;
