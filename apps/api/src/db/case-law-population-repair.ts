import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { Temporal } from "@stll/time";

import { loadGateHealthConfig } from "@/api/env-online-index";
import { CASE_LAW_POPULATION_SEED_REPAIR_NAME } from "@/api/lib/case-law/population-count-limits";
import {
  CASE_LAW_POPULATION_SEED_BATCH_SIZE,
  caseLawPopulationSeedBatchSize,
  caseLawPopulationSeedConfig,
  readCaseLawPopulationSeedBatch,
  retryLockRefusal,
} from "@/api/lib/case-law/population-seed-batch";
import { isRecord } from "@/api/lib/type-guards";

import {
  BackfillHeldError,
  createBackfillRuntime,
  decodeCheckpoint,
} from "./backfill-runtime";
import type { OnlineRepair } from "./online-migration-connection";

const HOLD_RETRY_FLOOR_MS = 1000;

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
    // The resume path's own decoder: a checkpoint it would refuse on the next
    // batch is refused here too, rather than admitted as pending.
    const { cursor, batch } = decodeCheckpoint(checkpoint);
    return {
      type: "pending",
      reason,
      cursor,
      holdUntil: batch.holdUntil,
      heldSince: batch.heldSince,
    };
  },
  repair: async (connection) => {
    const runtime = createBackfillRuntime({
      name: CASE_LAW_POPULATION_SEED_REPAIR_NAME,
      tableName: "case_law_decisions",
      initialSize: CASE_LAW_POPULATION_SEED_BATCH_SIZE,
      config: caseLawPopulationSeedConfig(loadGateHealthConfig()),
      connection,
    });
    try {
      const pass = await runBackfillPass({
        holdPolicy: "propagate",
        sleep: Bun.sleep,
        step: async () => {
          const batch = await retryLockRefusal(
            async () =>
              await runtime.step(async ({ tx, size }) =>
                readCaseLawPopulationSeedBatch(
                  (
                    await tx.query(
                      "SELECT cursor, processed, done FROM public.seed_case_law_population_counts($1)",
                      [caseLawPopulationSeedBatchSize(size)],
                    )
                  ).at(0),
                ),
              ),
          );
          if (batch.isErr()) {
            throw batch.error;
          }
          return batch.value;
        },
      });
      if (pass.isErr()) {
        if (!(pass.error instanceof BackfillHeldError)) {
          throw pass.error;
        }
        // A hold defers the phase rather than ending the run, so a migrate
        // run that keeps going finishes the seed; the scheduled owner
        // (`caseLaw.seedPopulationCounts`) resumes it after one that did not.
        return {
          type: "deferred",
          step: CASE_LAW_POPULATION_SEED_REPAIR_NAME,
          retryAfterMs: Math.max(
            HOLD_RETRY_FLOOR_MS,
            (pass.error.holdUntil ?? 0) -
              Temporal.Now.instant().epochMilliseconds,
          ),
        };
      }
      return { type: "complete" };
    } finally {
      await runtime.close();
    }
  },
} satisfies OnlineRepair;
