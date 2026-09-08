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
 * satisfies the constraint already. Completion is a catalog fact,
 * `pg_constraint.convalidated`, which is also what the API's startup gate
 * reads.
 */

import { panic } from "better-result";

import { isRecord } from "../lib/type-guards";
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
  OFFSET ${BATCH - 1}
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

const READ_CONSTRAINT_STATE_SQL = `
  SELECT constraint_state.convalidated AS "isValidated"
  FROM pg_catalog.pg_constraint constraint_state
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = constraint_state.conrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_relation.relnamespace
  WHERE table_namespace.nspname = $1
    AND table_relation.relname = $2
    AND constraint_state.conname = $3
`;

const readBatchBoundary = async (
  connection: OnlineMigrationConnection,
  cursor: string,
): Promise<string | null> => {
  const row = (await connection.query(READ_BATCH_BOUNDARY_SQL, [cursor])).at(0);
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

/**
 * One batch in its own transaction; the primary key the next batch starts
 * after, or null once the walk has repaired the tail of the table.
 */
const repairOneBatch = async (
  connection: OnlineMigrationConnection,
  cursor: string,
): Promise<string | null> => {
  await connection.execute("BEGIN");
  // Transaction boundary on a raw connection: a failed batch is rolled back so
  // the session stays usable for the lock release, then rethrown to fail the
  // migrate task, whose retry resumes from the rows still selected.
  try {
    await connection.execute(
      `SET LOCAL lock_timeout = '${BATCH_LOCK_TIMEOUT}'`,
    );
    await connection.execute(
      `SET LOCAL statement_timeout = '${BATCH_STATEMENT_TIMEOUT}'`,
    );
    const boundary = await readBatchBoundary(connection, cursor);
    if (boundary === null) {
      await connection.execute(REPAIR_TAIL_SQL, [cursor]);
      await connection.execute("COMMIT");
      return null;
    }
    await connection.execute(REPAIR_RANGE_SQL, [cursor, boundary]);
    await connection.execute("COMMIT");
    return boundary;
  } catch (error: unknown) {
    await connection.execute("ROLLBACK");
    throw error;
  }
};

/**
 * Walk the table in batches. Recursive rather than a loop with an awaited
 * body: each batch depends on the previous one having committed, so the
 * sequencing is structural.
 */
const repairFrom = async (
  connection: OnlineMigrationConnection,
  cursor: string,
): Promise<void> => {
  const next = await repairOneBatch(connection, cursor);
  if (next === null) {
    return;
  }
  await repairFrom(connection, next);
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

const assertConstraintValidated = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  const row = (
    await connection.query(READ_CONSTRAINT_STATE_SQL, [
      "public",
      TABLE_NAME,
      CONSTRAINT_NAME,
    ])
  ).at(0);
  if (row === undefined) {
    panic(
      `Online repair ${REPAIR_NAME}: constraint ${CONSTRAINT_NAME} is missing`,
    );
  }
  if (!isRecord(row) || typeof row["isValidated"] !== "boolean") {
    panic(
      `Online repair ${REPAIR_NAME}: constraint state has an invalid shape`,
    );
  }
  if (!row["isValidated"]) {
    panic(
      `Online repair ${REPAIR_NAME} is not complete: constraint ${CONSTRAINT_NAME} is not validated`,
    );
  }
};

export const CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR: OnlineRepair = {
  name: REPAIR_NAME,
  repair: async (connection) => {
    await repairFrom(connection, ID_FLOOR);
    await validateConstraint(connection);
  },
  assertComplete: assertConstraintValidated,
};
