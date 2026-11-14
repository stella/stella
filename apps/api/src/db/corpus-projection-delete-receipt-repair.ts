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

import {
  type CorpusProjectionRevisionWalkRuntime,
  walkCorpusProjectionRevisions,
} from "./corpus-projection-revision-walk";
import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation, OnlineTableGate } from "./online-ddl";
import type {
  MigrationOwnedOnlineRepair,
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
} from "./online-migration-connection";

const REPAIR_NAME = "corpus-projection-delete-receipt";
const TABLE_NAME = "corpus_index_projection_intents";
const CONSTRAINT_NAME = "corpus_index_projection_intents_delete_receipt_paired";

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

export const CORPUS_PROJECTION_DELETE_RECEIPT_CONSTRAINTS = [
  { tableName: TABLE_NAME, constraintName: CONSTRAINT_NAME },
] as const satisfies readonly OnlineConstraintValidation[];

/**
 * VALIDATE takes SHARE UPDATE EXCLUSIVE, which queues behind an autovacuum of
 * the table until that vacuum notices the waiter and yields; the gate watches
 * that wait and defers the phase rather than failing it.
 */
const validateConstraint = async (
  connection: OnlineMigrationConnection,
  tables: OnlineTableGate,
): Promise<OnlineMigrationOutcome> =>
  await validateOnlineConstraints({
    connection,
    tables,
    constraints: CORPUS_PROJECTION_DELETE_RECEIPT_CONSTRAINTS,
  });

export const createCorpusProjectionDeleteReceiptRepair = (
  options: CorpusProjectionRevisionWalkRuntime = {},
): MigrationOwnedOnlineRepair => ({
  introducedBy: "20260908140000_corpus_projection_delete_task_instant",
  name: REPAIR_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      constraintName: CONSTRAINT_NAME,
      repairName: REPAIR_NAME,
      backfillName: REPAIR_NAME,
      tableName: TABLE_NAME,
    }),
  repair: async (connection, tables) => {
    // Empty fresh databases have no heavy data work and no metric source yet.
    if (
      (await connection.query(`SELECT 1 FROM public."${TABLE_NAME}" LIMIT 1`))
        .length === 0
    ) {
      return await validateConstraint(connection, tables);
    }
    const pass = await walkCorpusProjectionRevisions(
      connection,
      {
        name: REPAIR_NAME,
        tableName: TABLE_NAME,
        repairRangeSql: REPAIR_RANGE_SQL,
        repairTailSql: REPAIR_TAIL_SQL,
      },
      options,
    );
    if (pass.isErr()) {
      throw pass.error;
    }
    return await validateConstraint(connection, tables);
  },
});

export const CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR =
  createCorpusProjectionDeleteReceiptRepair();
