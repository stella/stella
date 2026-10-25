/**
 * Online repair behind migration
 * 20261025090300_file_reservation_reconciliation_state.
 *
 * The migration adds the reconciliation columns and their checks NOT VALID.
 * A write row recorded before then carries a write identity and no
 * `reconcile_after`, so the sweep would never pick it up; this schedules each
 * such row five minutes after its own last write, the delay a writer leaves
 * an unscheduled write, and once none is left validates the checks.
 *
 * Self-checkpointing: a scheduled row leaves the selection, so an interrupted
 * run resumes by running again and a completed run finds nothing. Rows written
 * after the migration are scheduled by the fill trigger already. Deploy and
 * startup admit a pending checkpoint; `pg_constraint.convalidated` proves
 * completion.
 */
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { createBackfillRuntime } from "./backfill-runtime";
import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation, OnlineTableGate } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const REPAIR_NAME = "file-object-reconciliation";
const TABLE_NAME = "organization_file_objects";

/** Rows per transaction; the runtime sizes later batches. */
const BATCH = 500;

const UNSCHEDULED = `write_id IS NOT NULL AND reconciliation_state = 'active' AND reconcile_after IS NULL`;

type Query = Pick<OnlineMigrationConnection, "query">;

/**
 * Schedules up to `size` rows and returns how many it scheduled. The outer
 * predicate repeats the selection, so a row a writer resolved or scheduled
 * meanwhile is re-checked on its new version after the row lock.
 */
const scheduleBatch = async (tx: Query, size: number): Promise<number> =>
  (
    await tx.query(
      `UPDATE public."${TABLE_NAME}"
          SET reconcile_after = updated_at + interval '5 minutes'
        WHERE ${UNSCHEDULED}
          AND object_key IN (
            SELECT object_key FROM public."${TABLE_NAME}"
             WHERE ${UNSCHEDULED}
             ORDER BY object_key
             LIMIT $1
          )
        RETURNING object_key`,
      [size],
    )
  ).length;

const hasUnscheduledRow = async (connection: Query): Promise<boolean> =>
  (
    await connection.query(
      `SELECT 1 FROM public."${TABLE_NAME}" WHERE ${UNSCHEDULED} LIMIT 1`,
    )
  ).length > 0;

export const FILE_OBJECT_RECONCILIATION_CONSTRAINTS = [
  "organization_file_objects_reconciliation_attempt_nonnegative",
  "organization_file_objects_reconciliation_state_domain",
  "organization_file_objects_reconciliation_lifecycle",
].map((constraintName) => ({
  tableName: TABLE_NAME,
  constraintName,
})) satisfies readonly OnlineConstraintValidation[];

const readCompletion = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineRepairCompletion> => {
  for (const { constraintName } of FILE_OBJECT_RECONCILIATION_CONSTRAINTS) {
    const completion = await readConstraintCompletion({
      connection,
      constraintName,
      repairName: REPAIR_NAME,
      backfillName: REPAIR_NAME,
      tableName: TABLE_NAME,
    });
    if (completion.type !== "complete") {
      return completion;
    }
  }
  return { type: "complete" };
};

type RepairRuntimeOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

const scheduleUntilEmpty = async (
  connection: OnlineMigrationConnection,
  { readVerdict, sleep = Bun.sleep, clock, log }: RepairRuntimeOptions,
) => {
  const runtime = createBackfillRuntime({
    name: REPAIR_NAME,
    tableName: TABLE_NAME,
    initialSize: BATCH,
    config: defaultConfig,
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
        await runtime.step(async ({ tx, size, cursor }) => {
          const scheduled = await scheduleBatch(tx, size);
          return { cursor, done: scheduled === 0, value: scheduled };
        }),
    });
  } finally {
    await runtime.close();
  }
};

/**
 * VALIDATE takes SHARE UPDATE EXCLUSIVE, which queues behind an autovacuum of
 * the table until that vacuum notices the waiter and yields; the gate watches
 * that wait and defers the phase rather than failing it.
 */
const validateConstraints = async (
  connection: OnlineMigrationConnection,
  tables: OnlineTableGate,
): Promise<OnlineMigrationOutcome> =>
  await validateOnlineConstraints({
    connection,
    tables,
    constraints: FILE_OBJECT_RECONCILIATION_CONSTRAINTS,
  });

export const createFileObjectReconciliationRepair = (
  options: RepairRuntimeOptions = {},
): OnlineRepair => ({
  name: REPAIR_NAME,
  readCompletion,
  repair: async (connection, tables) => {
    // Fresh and repaired databases have no data work or metric source.
    if (!(await hasUnscheduledRow(connection))) {
      return await validateConstraints(connection, tables);
    }
    const pass = await scheduleUntilEmpty(connection, options);
    if (pass.isErr()) {
      // A held pass propagates for the online phase to defer, as every repair
      // behind `runBackfillPass` does.
      throw pass.error;
    }
    return await validateConstraints(connection, tables);
  },
});

export const FILE_OBJECT_RECONCILIATION_REPAIR =
  createFileObjectReconciliationRepair();
