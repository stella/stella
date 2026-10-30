import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig } from "@stll/db-load-gate/health";

import { isRecord } from "@/api/lib/type-guards";

import { createBackfillRuntime } from "./backfill-runtime";
import type { OnlineRepair } from "./online-migration-connection";

const REPAIR_NAME = "case-law-population-counts";
const BATCH_SIZE = 128;
const MAX_BATCH_SIZE = 256;

/** A row projection is the data checkpoint; the cursor bounds seed discovery. */
export const CASE_LAW_POPULATION_REPAIR = {
  introducedBy: "20261030222000_case_law_population_counts",
  name: REPAIR_NAME,
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
        [REPAIR_NAME],
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
      name: REPAIR_NAME,
      tableName: "case_law_decisions",
      initialSize: BATCH_SIZE,
      config: {
        ...defaultConfig,
        maxSize: MAX_BATCH_SIZE,
        batchStatementTimeoutMs: 5000,
        batchLockTimeoutMs: 1000,
      },
      connection,
    });
    try {
      const pass = await runBackfillPass({
        holdPolicy: "propagate",
        sleep: Bun.sleep,
        step: async () =>
          await runtime.step(async ({ tx, size }) => {
            const row = (
              await tx.query(
                "SELECT cursor, processed, done FROM public.seed_case_law_population_counts($1)",
                [Math.min(size, MAX_BATCH_SIZE)],
              )
            ).at(0);
            if (
              !isRecord(row) ||
              !(row["cursor"] === null || typeof row["cursor"] === "string") ||
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
