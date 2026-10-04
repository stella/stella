/**
 * Online repair behind migration
 * 20260908140000_corpus_projection_delete_task_instant.
 *
 * The migration adds `delete_task_created_at` and pairs it with
 * `delete_opstamp` by a NOT VALID check, because settlement now proves a
 * delete against the splits published no later than the task that issued it.
 * Receipts recorded before the column existed carry an opstamp and no
 * instant, and settlement skips them, so the data work runs here: every such
 * receipt takes the instant its own row was last written at, and once none is
 * left the constraint is validated.
 *
 * `updated_at` is a local instant, not the metastore's. It is at or after the
 * moment the task was recorded, so it excludes no split the metastore
 * published before the task, which is the direction that keeps the proof
 * honest; the exact revision count in the settlement proof is what makes that
 * proof exact either way.
 *
 * Self-checkpointing in two senses: a repaired row leaves the selection
 * predicate, so a completed run changes nothing and an interrupted run
 * resumes by running again, and every row written after the migration
 * satisfies the constraint already. The keyset cursor and adaptive holds are
 * committed with each batch. Deploy and startup admit a pending checkpoint;
 * `pg_constraint.convalidated` proves the walk completed.
 */

import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import { readConstraintCompletion } from "./online-constraint-completion";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";

const REPAIR_NAME = "corpus-projection-delete-receipt";
const TABLE_NAME = "corpus_index_projection_intents";
const CONSTRAINT_NAME = "corpus_index_projection_intents_delete_receipt_paired";

/**
 * Rows per transaction, walked in primary-key order. The batch is a bounded
 * index range rather than a scan for the rows that still need the instant:
 * those have no index of their own, and the table keeps one row per append
 * attempt of the whole corpus.
 */
const BATCH = 1000;
const BATCH_LOCK_TIMEOUT = "30s";
const BATCH_STATEMENT_TIMEOUT = "1min";
/**
 * VALIDATE takes SHARE UPDATE EXCLUSIVE, which queues behind an autovacuum of
 * the table until that vacuum notices the waiter and yields. Longer than the
 * online phase's default, which is sized for index builds; the phase restores
 * its own setting afterwards.
 */
const VALIDATE_LOCK_TIMEOUT = "1min";

/** Primary-key floor: every UUID sorts after it, so the walk starts here. */
const ID_FLOOR = "00000000-0000-0000-0000-000000000000";

const READ_BATCH_BOUNDARY_SQL = `
  SELECT id
  FROM public."${TABLE_NAME}"
  WHERE id > $1
  ORDER BY id
  OFFSET $2
  LIMIT 1
`;

const REPAIR_RANGE_SQL = `
  UPDATE public."${TABLE_NAME}"
  SET "delete_task_created_at" = "updated_at"
  WHERE id > $1
    AND id <= $2
    AND "delete_opstamp" IS NOT NULL
    AND "delete_task_created_at" IS NULL
`;

const REPAIR_TAIL_SQL = `
  UPDATE public."${TABLE_NAME}"
  SET "delete_task_created_at" = "updated_at"
  WHERE id > $1
    AND "delete_opstamp" IS NOT NULL
    AND "delete_task_created_at" IS NULL
`;

const readBatchBoundary = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  cursor: string,
  size: number,
): Promise<string | null> => {
  const row = (
    await connection.query(READ_BATCH_BOUNDARY_SQL, [cursor, size - 1])
  ).at(0);
  if (row === undefined) {
    return null;
  }
  if (!isRecord(row) || typeof row["id"] !== "string") {
    return panic(
      `Online repair ${REPAIR_NAME}: batch boundary has an invalid shape`,
    );
  }
  return row["id"];
};

/** A keyset cursor advances atomically with the idempotent range UPDATE. */
const repairFrom = async (
  connection: OnlineMigrationConnection,
  { readVerdict, sleep = Bun.sleep, clock, log }: RepairRuntimeOptions,
) => {
  const runtime = createBackfillRuntime({
    name: REPAIR_NAME,
    tableName: TABLE_NAME,
    initialSize: BATCH,
    config: {
      ...defaultConfig,
      batchLockTimeoutMs: 30_000,
      batchStatementTimeoutMs: 60_000,
    },
    connection,
    readVerdict,
    clock,
    log,
  });
  try {
    return await runBackfillPass({
      holdPolicy: "propagate",
      sleep,
      step: async () =>
        await runtime.step(async ({ tx, cursor, size }) => {
          await tx.execute(`SET LOCAL lock_timeout = '${BATCH_LOCK_TIMEOUT}'`);
          await tx.execute(
            `SET LOCAL statement_timeout = '${BATCH_STATEMENT_TIMEOUT}'`,
          );
          const floor = cursor ?? ID_FLOOR;
          const boundary = await readBatchBoundary(tx, floor, size);
          if (boundary === null) {
            await tx.execute(REPAIR_TAIL_SQL, [floor]);
            return { cursor: floor, done: true, value: null };
          }
          await tx.execute(REPAIR_RANGE_SQL, [floor, boundary]);
          return { cursor: boundary, done: false, value: null };
        }),
    });
  } finally {
    await runtime.close();
  }
};

const validateConstraint = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  await connection.execute(`SET lock_timeout = '${VALIDATE_LOCK_TIMEOUT}'`);
  // A no-op on an already validated constraint, which is what makes the
  // repair a fixed point.
  await connection.execute(
    `ALTER TABLE public."${TABLE_NAME}" VALIDATE CONSTRAINT "${CONSTRAINT_NAME}"`,
  );
};

type RepairRuntimeOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

export const createCorpusProjectionDeleteReceiptRepair = (
  options: RepairRuntimeOptions = {},
): OnlineRepair => ({
  name: REPAIR_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      constraintName: CONSTRAINT_NAME,
      repairName: REPAIR_NAME,
      backfillName: REPAIR_NAME,
      tableName: TABLE_NAME,
    }),
  repair: async (connection) => {
    // Empty fresh databases have no heavy data work and no metric source yet.
    if (
      (await connection.query(`SELECT 1 FROM public."${TABLE_NAME}" LIMIT 1`))
        .length === 0
    ) {
      await validateConstraint(connection);
      return;
    }
    const pass = await repairFrom(connection, options);
    if (pass.isErr()) {
      throw pass.error;
    }
    await validateConstraint(connection);
  },
});

export const CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR =
  createCorpusProjectionDeleteReceiptRepair();
