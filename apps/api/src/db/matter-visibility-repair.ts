import { panic, Result, TaggedError } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";
import { INTERNAL_MEMBER_ROLES } from "@stll/permissions";

import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import { readMatterVisibilityCutoverSql } from "./matter-visibility-sql";
import { readConstraintCompletion } from "./online-constraint-completion";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";

const REPAIR_NAME = "matter-visibility";
const TABLE_NAME = "workspaces";
const CONSTRAINT_NAME = "workspaces_visibility_check";
const BATCH_SIZE = 100;

class MatterVisibilityRepairBlocked extends TaggedError(
  "MatterVisibilityRepairBlocked",
)<{
  message: string;
  cause: unknown;
}> {}

// Repair only clientless legacy matters. The selected matter locks serialize
// membership role changes with the steward read and both writes.
const REPAIR_STEWARDS_SQL = `
  UPDATE public.workspaces AS w
  SET lead_user_id = steward.user_id
  FROM (
    SELECT DISTINCT ON (wm.workspace_id) wm.workspace_id, wm.user_id
    FROM public.workspace_members AS wm
    JOIN public.workspaces AS matter ON matter.id = wm.workspace_id
    JOIN public.member AS m
      ON m.user_id = wm.user_id
      AND m.organization_id = matter.organization_id
    WHERE matter.id = ANY(string_to_array($1, ',')::uuid[])
      AND m.role = ANY(string_to_array($2, ','))
      AND NOT EXISTS (
        SELECT 1
        FROM public.workspace_members AS lead_assignment
        JOIN public.member AS lead_member
          ON lead_member.user_id = lead_assignment.user_id
          AND lead_member.organization_id = matter.organization_id
        WHERE lead_assignment.workspace_id = matter.id
          AND lead_assignment.user_id = matter.lead_user_id
          AND lead_member.role = ANY(string_to_array($2, ','))
      )
    ORDER BY wm.workspace_id, wm.created_at, wm.id
  ) AS steward
  WHERE w.id = steward.workspace_id
`;

const REPAIR_VISIBILITY_SQL = `
  UPDATE public.workspaces AS w
  SET visibility = 'assigned_only'
  WHERE w.id = ANY(string_to_array($1, ',')::uuid[])
    AND EXISTS (
      SELECT 1
      FROM public.workspace_members AS wm
      JOIN public.member AS m
        ON m.user_id = wm.user_id
        AND m.organization_id = w.organization_id
      WHERE wm.workspace_id = w.id
        AND wm.user_id = w.lead_user_id
        AND m.role = ANY(string_to_array($2, ','))
    )
`;

type RepairRuntimeOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

const backfill = async (
  connection: OnlineMigrationConnection,
  { readVerdict, sleep = Bun.sleep, clock, log }: RepairRuntimeOptions,
) => {
  const runtime = createBackfillRuntime({
    name: REPAIR_NAME,
    tableName: TABLE_NAME,
    initialSize: BATCH_SIZE,
    config: {
      ...defaultConfig,
      maxSize: BATCH_SIZE,
      batchLockTimeoutMs: 1000,
      batchStatementTimeoutMs: 30_000,
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
          const rows = await tx.query(
            "SELECT id FROM public.stella_lock_legacy_visibility_batch($1::uuid, $2)",
            [cursor, size],
          );
          const ids = rows.map((row) => {
            if (!isRecord(row) || typeof row["id"] !== "string") {
              return panic(
                "Matter visibility repair received an invalid matter id",
              );
            }
            return row["id"];
          });
          const next = ids.at(-1);
          if (next === undefined) {
            return { cursor, done: true, value: null };
          }
          await tx.execute(REPAIR_STEWARDS_SQL, [
            ids.join(","),
            INTERNAL_MEMBER_ROLES.join(","),
          ]);
          await tx.execute(REPAIR_VISIBILITY_SQL, [
            ids.join(","),
            INTERNAL_MEMBER_ROLES.join(","),
          ]);
          return { cursor: next, done: false, value: null };
        }),
    });
  } finally {
    await runtime.close();
  }
};

const cutover = async (connection: OnlineMigrationConnection) => {
  await connection.execute("BEGIN");
  const result = await Result.tryPromise(async () => {
    await connection.execute("SET LOCAL lock_timeout = '1s'");
    await connection.execute("SET LOCAL statement_timeout = '1min'");
    for (const statement of readMatterVisibilityCutoverSql()) {
      await connection.execute(statement);
    }
    await connection.execute(
      `ALTER TABLE public.workspaces VALIDATE CONSTRAINT "${CONSTRAINT_NAME}"`,
    );
    await connection.execute("COMMIT");
  });
  if (result.isErr()) {
    await connection.execute("ROLLBACK");
    throw result.error;
  }
};

const readCompletion = async (connection: OnlineMigrationConnection) =>
  await readConstraintCompletion({
    connection,
    constraintName: CONSTRAINT_NAME,
    repairName: REPAIR_NAME,
    tableName: TABLE_NAME,
  });

/**
 * Legacy access stays active throughout the bounded walk. New API tasks must
 * not start while it is pending: their visibility writes require the new SQL
 * rule. The validated constraint marks the atomic cutover, and the runtime
 * cursor resumes interrupted batches without admitting a pending deployment.
 */
export const createMatterVisibilityRepair = (
  options: RepairRuntimeOptions = {},
): OnlineRepair => ({
  name: REPAIR_NAME,
  readCompletion,
  repair: async (connection) => {
    if ((await readCompletion(connection)).type === "complete") {
      return;
    }
    // A fresh database needs no health-gated walk or external metric source.
    if (
      (await connection.query("SELECT 1 FROM public.workspaces LIMIT 1"))
        .length > 0
    ) {
      const pass = await backfill(connection, options);
      if (pass.isErr()) {
        // The shared online runner admits held repairs with pending checkpoints;
        // this security cutover must instead block deployment on every hold.
        throw new MatterVisibilityRepairBlocked({
          message: "Matter visibility backfill must finish before deployment",
          cause: pass.error,
        });
      }
    }
    await cutover(connection);
  },
});

export const MATTER_VISIBILITY_REPAIR = createMatterVisibilityRepair();
