import { panic, Result } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";

import { loadGateHealthConfig } from "@/api/env-online-index";
import { CASE_LAW_POPULATION_SEED_REPAIR_NAME } from "@/api/lib/case-law/population-count-limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";

import { createBackfillRuntime } from "./backfill-runtime";
import type { OnlineRepair } from "./online-migration-connection";

const BATCH_SIZE = 128;
const MAX_BATCH_SIZE = 256;
/**
 * A batch waits on one decision row at most, so this outlasts a queue of
 * writer transactions on that row instead of losing to a busy decision.
 */
const BATCH_LOCK_TIMEOUT_MS = 15_000;
const BATCH_STATEMENT_TIMEOUT_MS = 30_000;
const LOCK_REFUSAL_RETRIES = 3;
const LOCK_REFUSAL_BACKOFF_MS = 1000;

/** A refused batch rolled back whole, so running it again replays nothing. */
const retryLockRefusal = async <Value>(
  step: () => Promise<Value>,
  attempt = 1,
): Promise<Value> => {
  const outcome = await Result.tryPromise({
    try: step,
    catch: (cause: unknown) => cause,
  });
  if (outcome.isOk()) {
    return outcome.value;
  }
  if (
    attempt > LOCK_REFUSAL_RETRIES ||
    !isPgError(outcome.error, PG_ERROR.LOCK_NOT_AVAILABLE)
  ) {
    throw outcome.error;
  }
  await Bun.sleep(LOCK_REFUSAL_BACKOFF_MS * attempt);
  return await retryLockRefusal(step, attempt + 1);
};

/** A row projection is the data checkpoint; the cursor bounds seed discovery. */
export const CASE_LAW_POPULATION_REPAIR = {
  introducedBy: "20261101022151_case_law_population_counts",
  name: CASE_LAW_POPULATION_SEED_REPAIR_NAME,
  readCompletion: async (connection) => {
    const row = (
      await connection.query(
        `SELECT phase FROM public.case_law_population_seed_state WHERE slot = 0`,
      )
    ).at(0);
    if (
      !isRecord(row) ||
      !["scan", "fold", "complete"].includes(String(row["phase"]))
    ) {
      return panic("Invalid case-law population seed state");
    }
    if (row["phase"] === "complete") {
      return { type: "complete" };
    }
    const reason = "Case-law population counts await bounded seeding";
    const checkpoint = (
      await connection.query(
        `SELECT cursor, batch FROM public.database_backfill_states WHERE name = $1`,
        [CASE_LAW_POPULATION_SEED_REPAIR_NAME],
      )
    ).at(0);
    if (checkpoint === undefined) {
      return { type: "incomplete", reason };
    }
    if (
      !isRecord(checkpoint) ||
      !(
        checkpoint["cursor"] === null ||
        typeof checkpoint["cursor"] === "string"
      ) ||
      !isRecord(checkpoint["batch"])
    ) {
      return panic("Invalid case-law population backfill checkpoint");
    }
    const batch = checkpoint["batch"];
    if (
      !(
        batch["holdUntil"] === null || typeof batch["holdUntil"] === "number"
      ) ||
      !(batch["heldSince"] === null || typeof batch["heldSince"] === "number")
    ) {
      return panic("Invalid case-law population backfill hold");
    }
    return {
      type: "pending",
      reason,
      cursor: checkpoint["cursor"],
      holdUntil: batch["holdUntil"],
      heldSince: batch["heldSince"],
    };
  },
  repair: async (connection) => {
    const runtime = createBackfillRuntime({
      name: CASE_LAW_POPULATION_SEED_REPAIR_NAME,
      tableName: "case_law_decisions",
      initialSize: BATCH_SIZE,
      config: {
        ...loadGateHealthConfig(),
        maxSize: MAX_BATCH_SIZE,
        batchStatementTimeoutMs: BATCH_STATEMENT_TIMEOUT_MS,
        batchLockTimeoutMs: BATCH_LOCK_TIMEOUT_MS,
      },
      connection,
    });
    try {
      const pass = await runBackfillPass({
        holdPolicy: "propagate",
        sleep: Bun.sleep,
        step: async () =>
          await retryLockRefusal(
            async () =>
              await runtime.step(async ({ tx, size }) => {
                const row = (
                  await tx.query(
                    "SELECT cursor, processed, done FROM public.seed_case_law_population_counts($1)",
                    [Math.min(size, MAX_BATCH_SIZE)],
                  )
                ).at(0);
                if (
                  !isRecord(row) ||
                  !(
                    row["cursor"] === null || typeof row["cursor"] === "string"
                  ) ||
                  typeof row["processed"] !== "number" ||
                  typeof row["done"] !== "boolean"
                ) {
                  return panic("Invalid case-law population seed batch");
                }
                return {
                  cursor: row["cursor"],
                  done: row["done"],
                  value: row["processed"],
                };
              }),
          ),
      });
      if (pass.isErr()) {
        throw pass.error;
      }
      return { type: "complete" };
    } finally {
      await runtime.close();
    }
  },
} satisfies OnlineRepair;
