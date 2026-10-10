import type { SQL } from "drizzle-orm";
/**
 * Online repair behind migration 20260902100000_case_law_decision_date_ceiling,
 * and behind 20260927200300_case_law_decision_date_floor_by_jurisdiction,
 * which swaps the same CHECK for a per-jurisdiction floor the same way.
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
 * script: 50 decisions per transaction, graph acquired before decision rows,
 * matching the ingestion pipeline; edges reopened through
 * the helpers the pipeline itself uses, each bounded by an index. The first
 * form of the migration did this with one UPDATE whose predicate
 * `case_law_citations` cannot serve from an index; on a corpus-sized table
 * that outruns any migration budget.
 *
 * Self-checkpointing: a repaired row leaves the selection predicate, so an
 * interrupted run resumes by running again, a completed run finds nothing, and
 * the rows supply the data checkpoint. The shared maintenance state persists
 * adaptive sizing and holds. A committed checkpoint admits a pending repair
 * through deploy and startup; `pg_constraint.convalidated` proves completion.
 */
import { PgDialect } from "drizzle-orm/pg-core";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";

import { CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT } from "../lib/decision-date-bounds-sql";
import type { CorruptDecisionDateRow } from "../scripts/repair-decision-dates-plan";
import { repairDecisionDateBatch } from "../scripts/repair-decision-dates-plan";
import { createBackfillRuntime } from "./backfill-runtime";
import { readConstraintCompletion } from "./online-constraint-completion";
import { onlineMigrationParams } from "./online-migration-connection";
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

const dialect = new PgDialect();

/**
 * The connection as the resolver helpers see it: a drizzle fragment rendered
 * to a parameterised query on the reserved connection, so the whole repair
 * shares the session that holds the online-migrations lock.
 */
const bindTo = (connection: Pick<OnlineMigrationConnection, "query">) => ({
  execute: async (query: SQL): Promise<unknown> => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    return await connection.query(text, onlineMigrationParams(params));
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

// Repaired dates whose projection desired state this pass could not move.
const reportUnreconciled = (rows: number): void => {
  if (rows === 0) {
    return;
  }
  process.stderr.write(
    `[migrate] ${REPAIR_NAME}: ${String(rows)} repaired row(s) await a corpus projection reconcile sweep\n`,
  );
};

/** The runtime owns the transaction, checkpoint, health read and per-batch slot. */
const repairUntilEmpty = async (
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
      batchStatementTimeoutMs: 300_000,
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
        await runtime.step(async ({ tx, size, cursor }) => {
          await tx.execute(`SET LOCAL lock_timeout = '${BATCH_LOCK_TIMEOUT}'`);
          await tx.execute(
            `SET LOCAL statement_timeout = '${BATCH_STATEMENT_TIMEOUT}'`,
          );
          const batch = await runCitationGraphTransaction(
            async (run) => await run(bindTo(tx)),
            async (graphTx) =>
              await repairDecisionDateBatch(graphTx, size, {
                reconcileProjection: null,
              }),
          );
          return {
            cursor,
            done: batch.cleared + batch.rederived + batch.skipped === 0,
            value: batch,
          };
        }),
      onBatch: ({ value }) => {
        reportUnannounced(value.unannounced);
        reportUnreconciled(value.unreconciled);
      },
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
    `ALTER TABLE public."${TABLE_NAME}" VALIDATE CONSTRAINT "${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}"`,
  );
};

type RepairRuntimeOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

export const createDecisionDateCeilingRepair = (
  options: RepairRuntimeOptions = {},
): OnlineRepair => ({
  name: REPAIR_NAME,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      constraintName: CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT,
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
    const pass = await repairUntilEmpty(connection, options);
    if (pass.isErr()) {
      throw pass.error;
    }
    await validateConstraint(connection);
  },
});

export const DECISION_DATE_CEILING_REPAIR = createDecisionDateCeilingRepair();
