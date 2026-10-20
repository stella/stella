import { panic, Result } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig } from "@stll/db-load-gate/health";

import { isRecord } from "@/api/lib/type-guards";

import { createBackfillRuntime } from "./backfill-runtime";
import { analyzeTable, validateConstraint } from "./online-ddl";
import type { OnlineTableGate } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
  OnlineRepair,
} from "./online-migration-connection";
import { setSharedQueryTimeouts } from "./shared-pool-timeouts";

const REPAIR_NAME = "entity-feature-row-gates";
const BATCH_SIZE = 128;
const MAX_BATCH_SIZE = 2048;

type GateRelation = {
  tableName: string;
  primaryKey: string[];
};

const readRelations = async (
  connection: OnlineMigrationConnection,
): Promise<GateRelation[]> => {
  const rows =
    await connection.query(`SELECT key AS name, value->'primaryKey' AS keys
    FROM jsonb_each(public.entity_feature_gate_graph())
    ORDER BY (value->>'order')::integer`);
  return rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row["name"] !== "string" ||
      !Array.isArray(row["keys"]) ||
      row["keys"].length === 0 ||
      !row["keys"].every((key): key is string => typeof key === "string")
    ) {
      return panic("Invalid entity feature backfill relation");
    }
    return { tableName: row["name"], primaryKey: row["keys"] };
  });
};

const runMaintenanceTransaction = async (
  connection: OnlineMigrationConnection,
  work: () => Promise<void>,
): Promise<void> => {
  await connection.execute("BEGIN");
  const outcome = await Result.tryPromise({
    try: async () => {
      await setSharedQueryTimeouts(connection.query, {
        statementTimeoutMs: 60_000,
        lockTimeoutMs: 1000,
      });
      await work();
      await connection.execute("COMMIT");
    },
    catch: (cause: unknown) => cause,
  });
  if (outcome.isErr()) {
    await connection.execute("ROLLBACK");
    throw outcome.error;
  }
};

/** Validated on every relation of the runtime gate graph. */
export const ENTITY_FEATURE_GATE_CONSTRAINT_NAMES = [
  "entity_feature_gate_states_check",
  "entity_feature_gate_ready_check",
] as const;

/**
 * ANALYZE and VALIDATE each take SHARE UPDATE EXCLUSIVE, which queues behind
 * an autovacuum of the table, so they run through the gate, one table at a
 * time; a deferral leaves the next run to repeat them.
 */
const analyzeAndValidate = async (
  tables: OnlineTableGate,
  tableName: string,
): Promise<OnlineMigrationOutcome> =>
  await tables.run({
    target: { tableName, name: `${tableName}.entity_feature_gate` },
    kind: "index_build",
    work: async (session) => {
      // Readiness is a durable no-pending proof. Cutover checks this catalog
      // flag, avoiding a second scan under the locks that replace all 47
      // policies.
      await session.run(analyzeTable(tableName));
      for (const constraintName of ENTITY_FEATURE_GATE_CONSTRAINT_NAMES) {
        await session.run(validateConstraint({ tableName, constraintName }));
      }
    },
  });

const backfillRelation = async (
  connection: OnlineMigrationConnection,
  tables: OnlineTableGate,
  { tableName }: GateRelation,
): Promise<OnlineMigrationOutcome> => {
  const pendingRows = await connection.query(
    "SELECT pending FROM public.entity_feature_gate_backfill($1, NULL, 0)",
    [tableName],
  );
  const pendingRow = pendingRows.at(0);
  if (!isRecord(pendingRow) || typeof pendingRow["pending"] !== "boolean") {
    return panic("Invalid entity feature backfill readiness");
  }
  if (!pendingRow["pending"]) {
    return await analyzeAndValidate(tables, tableName);
  }
  const runtime = createBackfillRuntime({
    name: `${REPAIR_NAME}:${tableName}`,
    tableName,
    initialSize: BATCH_SIZE,
    config: { ...defaultConfig, maxSize: MAX_BATCH_SIZE },
    connection,
  });
  try {
    const pass = await runBackfillPass({
      holdPolicy: "propagate",
      sleep: Bun.sleep,
      step: async () =>
        await runtime.step(async ({ tx, size, cursor }) => {
          // Stable primary-key tuples survive VACUUM, process restarts and
          // physical row movement; concurrent inserts cannot remain pending.
          const rows = await tx.query(
            "SELECT cursor, count, pending FROM public.entity_feature_gate_backfill($1, $2, $3)",
            [tableName, cursor, size],
          );
          const row = rows.at(0);
          if (
            !isRecord(row) ||
            typeof row["count"] !== "number" ||
            !(row["cursor"] === null || typeof row["cursor"] === "string")
          ) {
            return panic("Invalid entity feature backfill batch");
          }
          if (row["count"] === 0 && row["pending"] !== false) {
            return panic(
              "Entity feature backfill checkpoint skipped pending rows",
            );
          }
          return {
            cursor: row["cursor"],
            done: row["count"] === 0,
            value: row["count"],
          };
        }),
    });
    if (pass.isErr()) {
      throw pass.error;
    }
  } finally {
    await runtime.close();
  }
  // Gate and empty-array selectivity must describe the backfilled data before
  // cutover; otherwise the planner can choose a nested loop over the tenant.
  return await analyzeAndValidate(tables, tableName);
};

export const ENTITY_FEATURE_GATE_REPAIR: OnlineRepair = {
  name: REPAIR_NAME,
  readCompletion: async (connection) => {
    const installed = (
      await connection.query(
        `SELECT to_regprocedure('public.entity_feature_gate_finish()') IS NOT NULL AS installed`,
      )
    ).at(0);
    if (!isRecord(installed) || typeof installed["installed"] !== "boolean") {
      return panic("Invalid entity feature migration state");
    }
    if (!installed["installed"]) {
      return { type: "complete" };
    }
    const rows =
      await connection.query(`SELECT count(*) = (SELECT count(*) FROM jsonb_object_keys(public.entity_feature_gate_graph()))
      AND bool_and((CASE WHEN tablename = 'entities' THEN coalesce(
          qual LIKE '%list_item_type IS NULL%' AND qual LIKE '%list_item_type = ''task''%'
          AND qual LIKE '%app.enabled_features%' AND qual LIKE '%? ''legal-lists''%', false)
        ELSE coalesce(qual LIKE '%entity_feature_gate%', false) END)
        AND permissive = 'RESTRICTIVE' AND cmd = 'ALL' AND 'stella' = ANY(roles)) AS complete
      FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND policyname = 'workspace_entity_feature'
        AND public.entity_feature_gate_graph() ? tablename`);
    const row = rows.at(0);
    if (!isRecord(row) || typeof row["complete"] !== "boolean") {
      return panic("Invalid entity feature cutover state");
    }
    if (row["complete"]) {
      return { type: "complete" };
    }
    const reason = "Entity feature gates await backfill and atomic cutover";
    const checkpoint = (
      await connection.query(
        `SELECT cursor, batch FROM public.database_backfill_states
      WHERE starts_with(name, $1) ORDER BY updated_at DESC LIMIT 1`,
        [`${REPAIR_NAME}:`],
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
      return panic("Invalid entity feature pending checkpoint");
    }
    const batch = checkpoint["batch"];
    if (
      !(
        batch["holdUntil"] === null || typeof batch["holdUntil"] === "number"
      ) ||
      !(batch["heldSince"] === null || typeof batch["heldSince"] === "number")
    ) {
      return panic("Invalid entity feature backfill hold");
    }
    return {
      type: "pending",
      reason,
      cursor: checkpoint["cursor"],
      holdUntil: batch["holdUntil"],
      heldSince: batch["heldSince"],
    };
  },
  repair: async (connection, tables) => {
    for (const relation of await readRelations(connection)) {
      const outcome = await backfillRelation(connection, tables, relation);
      if (outcome.type === "deferred") {
        return outcome;
      }
    }
    await runMaintenanceTransaction(connection, async () => {
      await connection.execute("SELECT public.entity_feature_gate_finish()");
    });
    return { type: "complete" };
  },
};
