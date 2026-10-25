/**
 * Online repairs behind migration
 * 20261025090500_document_derivative_entity_ownership.
 *
 * The migration keys every review and bilingual run to its document with an
 * `ON DELETE CASCADE` foreign key, NOT VALID. Runs of documents permanently
 * deleted before then have no document left; their erasure is what document
 * deletion promises, so this removes them and then validates the key. An
 * entity never changes workspace and `entity_id` is NOT NULL, so only runs of
 * deleted documents match.
 *
 * Self-checkpointing: the walk advances a primary-key cursor committed with
 * each batch, a removed run leaves the selection, and runs written after the
 * migration already satisfy the key. Deploy and startup admit a pending
 * checkpoint; `pg_constraint.convalidated` proves completion.
 */
import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";

/** Runs per transaction, walked in primary-key order. */
const BATCH = 500;

/** Primary-key floor: every UUID sorts after it, so the walk starts here. */
const ID_FLOOR = "00000000-0000-0000-0000-000000000000";

export const DOCUMENT_DERIVATIVE_RUN_OWNERSHIP_CONSTRAINTS = [
  {
    tableName: "bilingual_translation_runs",
    constraintName: "bilingual_translation_runs_entity_workspace_fk",
  },
  {
    tableName: "document_review_runs",
    constraintName: "document_review_runs_entity_workspace_fk",
  },
] as const satisfies readonly OnlineConstraintValidation[];

type RunOwnershipConstraint =
  (typeof DOCUMENT_DERIVATIVE_RUN_OWNERSHIP_CONSTRAINTS)[number];

type RepairRuntimeOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

const ORPHAN_RUN = `NOT EXISTS (
    SELECT 1 FROM public."entities" AS entity
     WHERE entity."id" = run."entity_id"
       AND entity."workspace_id" = run."workspace_id"
  )`;

const readBatchBoundary = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  {
    tableName,
    cursor,
    size,
  }: { tableName: string; cursor: string; size: number },
): Promise<string | null> => {
  const row = (
    await connection.query(
      `SELECT id FROM public."${tableName}" WHERE id > $1 ORDER BY id OFFSET $2 LIMIT 1`,
      [cursor, size - 1],
    )
  ).at(0);
  if (row === undefined) {
    return null;
  }
  if (!isRecord(row) || typeof row["id"] !== "string") {
    return panic(
      `Online repair ${tableName}: batch boundary has an invalid shape`,
    );
  }
  return row["id"];
};

const eraseOrphanRuns = async (
  connection: OnlineMigrationConnection,
  { tableName }: RunOwnershipConstraint,
  { readVerdict, sleep = Bun.sleep, clock, log }: RepairRuntimeOptions,
) => {
  const runtime = createBackfillRuntime({
    name: `${tableName}-entity-ownership`,
    tableName,
    initialSize: BATCH,
    // The runtime sets these timeouts on every batch transaction.
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
          const floor = cursor ?? ID_FLOOR;
          const boundary = await readBatchBoundary(tx, {
            tableName,
            cursor: floor,
            size,
          });
          if (boundary === null) {
            await tx.execute(
              `DELETE FROM public."${tableName}" AS run WHERE run.id > $1 AND ${ORPHAN_RUN}`,
              [floor],
            );
            return { cursor: floor, done: true, value: null };
          }
          await tx.execute(
            `DELETE FROM public."${tableName}" AS run WHERE run.id > $1 AND run.id <= $2 AND ${ORPHAN_RUN}`,
            [floor, boundary],
          );
          return { cursor: boundary, done: false, value: null };
        }),
    });
  } finally {
    await runtime.close();
  }
};

const createRunOwnershipRepair = (
  constraint: RunOwnershipConstraint,
  options: RepairRuntimeOptions,
): OnlineRepair => ({
  name: constraint.constraintName,
  readCompletion: async (connection) =>
    await readConstraintCompletion({
      connection,
      constraintName: constraint.constraintName,
      repairName: constraint.constraintName,
      backfillName: `${constraint.tableName}-entity-ownership`,
      tableName: constraint.tableName,
    }),
  repair: async (connection, tables) => {
    // Empty fresh databases have no data work and no metric source yet.
    const hasRuns =
      (
        await connection.query(
          `SELECT 1 FROM public."${constraint.tableName}" LIMIT 1`,
        )
      ).length > 0;
    if (hasRuns) {
      const pass = await eraseOrphanRuns(connection, constraint, options);
      if (pass.isErr()) {
        // A held pass propagates for the online phase to defer, as every
        // repair behind `runBackfillPass` does.
        throw pass.error;
      }
    }
    return await validateOnlineConstraints({
      connection,
      tables,
      constraints: [constraint],
    });
  },
});

export const createDocumentDerivativeRunOwnershipRepairs = (
  options: RepairRuntimeOptions = {},
): readonly OnlineRepair[] =>
  DOCUMENT_DERIVATIVE_RUN_OWNERSHIP_CONSTRAINTS.map((constraint) =>
    createRunOwnershipRepair(constraint, options),
  );

export const DOCUMENT_DERIVATIVE_RUN_OWNERSHIP_REPAIRS =
  createDocumentDerivativeRunOwnershipRepairs();
