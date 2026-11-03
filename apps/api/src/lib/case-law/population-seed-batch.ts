import { panic, Result } from "better-result";

import type { HealthConfig } from "@stll/db-load-gate/health";

import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";

export const CASE_LAW_POPULATION_SEED_BATCH_SIZE = 128;
const MAX_BATCH_SIZE = 256;
/**
 * A batch waits on one decision row at most, so this outlasts a queue of
 * writer transactions on that row instead of losing to a busy decision.
 */
const BATCH_LOCK_TIMEOUT_MS = 15_000;
const BATCH_STATEMENT_TIMEOUT_MS = 30_000;
const LOCK_REFUSAL_RETRIES = 3;
const LOCK_REFUSAL_BACKOFF_MS = 1000;

/**
 * The bounds every caller of the seed runs under. The migrate run and the
 * scheduled owner share one checkpoint row and one heavy-work slot, and the
 * seed function serializes them on its state row, so either may advance the
 * seed and neither replays the other's batches.
 */
export const caseLawPopulationSeedConfig = (
  health: HealthConfig,
): HealthConfig => ({
  ...health,
  maxSize: MAX_BATCH_SIZE,
  batchStatementTimeoutMs: BATCH_STATEMENT_TIMEOUT_MS,
  batchLockTimeoutMs: BATCH_LOCK_TIMEOUT_MS,
});

/** The seed function rejects a larger batch; the runtime may grow past it. */
export const caseLawPopulationSeedBatchSize = (size: number): number =>
  Math.min(size, MAX_BATCH_SIZE);

type CaseLawPopulationSeedBatch = {
  cursor: string | null;
  done: boolean;
  value: number;
};

/** One `seed_case_law_population_counts` row, as the runtime records it. */
export const readCaseLawPopulationSeedBatch = (
  row: unknown,
): CaseLawPopulationSeedBatch => {
  if (
    !isRecord(row) ||
    !(row["cursor"] === null || typeof row["cursor"] === "string") ||
    typeof row["processed"] !== "number" ||
    typeof row["done"] !== "boolean"
  ) {
    return panic("Invalid case-law population seed batch");
  }
  return { cursor: row["cursor"], done: row["done"], value: row["processed"] };
};

/**
 * A refused batch rolled back whole, so running it again replays nothing.
 * Any other failure, or a refusal past the retries, is the caller's.
 */
export const retryLockRefusal = async <Value>(
  step: () => Promise<Value>,
  attempt = 1,
): Promise<Result<Value, unknown>> => {
  const outcome = await Result.tryPromise({
    try: step,
    catch: (cause: unknown) => cause,
  });
  if (
    outcome.isOk() ||
    attempt > LOCK_REFUSAL_RETRIES ||
    !isPgError(outcome.error, PG_ERROR.LOCK_NOT_AVAILABLE)
  ) {
    return outcome;
  }
  await Bun.sleep(LOCK_REFUSAL_BACKOFF_MS * attempt);
  return await retryLockRefusal(step, attempt + 1);
};
