/**
 * Online repair behind migration 20260902100000_case_law_decision_date_ceiling.
 *
 * The migration swaps the CHECK on `case_law_decisions.decision_date` for one
 * with a stricter ceiling and leaves it NOT VALID. The data work runs here,
 * after the schema migrations and under the online-migrations lock: every
 * decision dated past the ceiling is cleared (or re-derived from its own
 * metadata), its search projection is invalidated, the citation edges decided
 * under the old date go back on the resolver's queue, and once no such row
 * remains the constraint is validated.
 *
 * The same plan and the same batch as `repair-decision-dates.ts`, the operator
 * script: 50 decisions per transaction, decision rows locked before the
 * citation-graph lock (the ingestion pipeline's order, which is what keeps a
 * concurrent refresh from deadlocking against a batch), edges reopened through
 * the helpers the pipeline itself uses, each bounded by an index. The first
 * form of the migration did this with one UPDATE whose predicate
 * `case_law_citations` cannot serve from an index; on a corpus-sized table
 * that outruns any migration budget.
 *
 * Self-checkpointing: a repaired row leaves the selection predicate, so an
 * interrupted run resumes by running again, a completed run finds nothing, and
 * there is no cursor or bookkeeping table to keep. Completion is a catalog
 * fact, `pg_constraint.convalidated`, which is also what the API's startup gate
 * reads.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT } from "../lib/decision-date-bounds-sql";
import { isRecord } from "../lib/type-guards";
import type { CorruptDecisionDateRow } from "../scripts/repair-decision-dates-plan";
import { repairDecisionDateBatch } from "../scripts/repair-decision-dates-plan";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";

const REPAIR_NAME = "decision-date-ceiling";
const TABLE_NAME = "case_law_decisions";

/**
 * Rows per transaction. Small on purpose: the batch holds the citation-graph
 * advisory lock while it reopens edges, and the standing resolver waits on it.
 */
const BATCH = 50;
/**
 * Per-batch budgets, LOCAL to the batch's transaction. The reopen statements
 * are the ones the ingestion pipeline runs on every refresh of a decision,
 * each bounded by an index to that decision's own edges, so the statement
 * budget is sized for a heavily cited decision rather than for a scan; a
 * batch that still runs into it is contended, and the migrate task's retry
 * resumes where the failed batch left off.
 */
const BATCH_LOCK_TIMEOUT = "30s";
const BATCH_STATEMENT_TIMEOUT = "5min";
/**
 * VALIDATE takes SHARE UPDATE EXCLUSIVE, which queues behind an autovacuum of
 * the table until that vacuum notices the waiter and yields. Longer than the
 * online phase's default, which is sized for index builds; the phase restores
 * its own setting afterwards.
 */
const VALIDATE_LOCK_TIMEOUT = "1min";

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

const dialect = new PgDialect();

/**
 * The connection as the resolver helpers see it: a drizzle fragment rendered
 * to a parameterised query on the reserved connection, so the whole repair
 * shares the session that holds the online-migrations lock.
 */
const bindTo = (connection: OnlineMigrationConnection) => ({
  execute: async (query: SQL): Promise<unknown> => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    return await connection.query(text, params);
  },
});

// The migrate task's log is its stderr; there is no app logger in that
// minimal environment. Loud rather than defaulted, as the pipeline is about
// a country with no resolution policy, and not fatal: the date is repaired,
// only the key re-announcement is owed.
const reportUnannounced = (rows: readonly CorruptDecisionDateRow[]): void => {
  for (const row of rows) {
    process.stderr.write(
      `[migrate] ${REPAIR_NAME}: ${row.id} stores country ${row.country}, which declares no resolution policy; its citation key was not re-announced\n`,
    );
  }
};

/** One batch in its own transaction; the number of rows it claimed. */
const repairOneBatch = async (
  connection: OnlineMigrationConnection,
): Promise<number> => {
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
    const batch = await repairDecisionDateBatch(bindTo(connection), BATCH);
    await connection.execute("COMMIT");
    reportUnannounced(batch.unannounced);
    return batch.cleared + batch.rederived + batch.skipped;
  } catch (error: unknown) {
    await connection.execute("ROLLBACK");
    throw error;
  }
};

/**
 * Repair batches until the selection is empty. Recursive rather than a loop
 * with an awaited body: each batch depends on the previous one having
 * committed, so the sequencing is structural.
 */
const repairUntilEmpty = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  const claimed = await repairOneBatch(connection);
  if (claimed === 0) {
    return;
  }
  await repairUntilEmpty(connection);
};

const validateConstraint = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  await connection.execute(`SET lock_timeout = '${VALIDATE_LOCK_TIMEOUT}'`);
  // A no-op on an already validated constraint, which is what makes the
  // repair a fixed point.
  await connection.execute(
    `ALTER TABLE public."${TABLE_NAME}" VALIDATE CONSTRAINT "${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}"`,
  );
};

const assertConstraintValidated = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  const row = (
    await connection.query(READ_CONSTRAINT_STATE_SQL, [
      "public",
      TABLE_NAME,
      CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT,
    ])
  ).at(0);
  if (row === undefined) {
    panic(
      `Online repair ${REPAIR_NAME}: constraint ${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT} is missing`,
    );
  }
  if (!isRecord(row) || typeof row["isValidated"] !== "boolean") {
    panic(
      `Online repair ${REPAIR_NAME}: constraint state has an invalid shape`,
    );
  }
  if (!row["isValidated"]) {
    panic(
      `Online repair ${REPAIR_NAME} is not complete: constraint ${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT} is not validated`,
    );
  }
};

export const DECISION_DATE_CEILING_REPAIR: OnlineRepair = {
  name: REPAIR_NAME,
  repair: async (connection) => {
    await repairUntilEmpty(connection);
    await validateConstraint(connection);
  },
  assertComplete: assertConstraintValidated,
};
