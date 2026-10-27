import { panic } from "better-result";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig } from "@stll/db-load-gate/health";

import * as schema from "@/api/db/schema";
import { isRecord } from "@/api/lib/type-guards";

import { createBackfillRuntime } from "./backfill-runtime";
import { entityFeaturePolicyDefinitions } from "./entity-feature-policies";
import { readConstraintValidated } from "./online-constraint-completion";
import { analyzeTable, replacePolicy, validateConstraint } from "./online-ddl";
import type { OnlineTableGate, PolicyDefinition } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
  OnlineRepair,
} from "./online-migration-connection";

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
      // flag, avoiding a second scan under the lock that replaces the
      // relation's policy.
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
    ...(tables.isPaused === undefined ? {} : { isPaused: tables.isPaused }),
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

const POLICY_NAME = "workspace_entity_feature";

/**
 * Whether a `pg_policies` row is the row-local gate policy the cutover
 * installs: the entities fence reads the list item type, every other relation
 * its backfilled gate column.
 */
const CUT_OVER_POLICY = `(CASE WHEN tablename = 'entities' THEN coalesce(
    qual LIKE '%list_item_type IS NULL%' AND qual LIKE '%list_item_type = ''task''%'
    AND qual LIKE '%app.enabled_features%' AND qual LIKE '%? ''legal-lists''%', false)
  ELSE coalesce(qual LIKE '%entity_feature_gate%', false) END)
  AND permissive = 'RESTRICTIVE' AND cmd = 'ALL' AND 'stella' = ANY(roles)`;

const readCutOver = async (
  connection: OnlineMigrationConnection,
  tableName: string,
): Promise<boolean> => {
  const row = (
    await connection.query(
      `SELECT coalesce(bool_and(${CUT_OVER_POLICY}), false) AS "cutOver"
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public' AND policyname = $1 AND tablename = $2`,
      [POLICY_NAME, tableName],
    )
  ).at(0);
  if (!isRecord(row) || typeof row["cutOver"] !== "boolean") {
    return panic("Invalid entity feature relation cutover state");
  }
  return row["cutOver"];
};

/**
 * Replaces one relation's feature policy with its row-local gate policy,
 * through the gate: a held or busy table defers the repair with the old
 * policy in place, and a relation already cut over costs one catalog read.
 */
const cutOverRelation = async (
  connection: OnlineMigrationConnection,
  tables: OnlineTableGate,
  policy: PolicyDefinition,
): Promise<OnlineMigrationOutcome> => {
  const { tableName } = policy;
  if (await readCutOver(connection, tableName)) {
    return { type: "complete" };
  }
  // The row-local policy is only as complete as the backfill under it.
  if (
    !(await readConstraintValidated({
      connection,
      tableName,
      constraintName: "entity_feature_gate_ready_check",
      reader: "Entity feature gate cutover",
    }))
  ) {
    return panic(`Entity feature gate cutover: ${tableName} is not backfilled`);
  }
  return await tables.run({
    target: { tableName, name: `${tableName}.${POLICY_NAME}` },
    kind: "index_build",
    work: async (session) => {
      await session.run(replacePolicy(policy));
    },
  });
};

const cutOverRelations = async (
  connection: OnlineMigrationConnection,
  tables: OnlineTableGate,
  policies: readonly PolicyDefinition[],
  offset = 0,
): Promise<OnlineMigrationOutcome> => {
  const policy = policies.at(offset);
  if (policy === undefined) {
    return { type: "complete" };
  }
  const outcome = await cutOverRelation(connection, tables, policy);
  if (outcome.type === "deferred") {
    return outcome;
  }
  return await cutOverRelations(connection, tables, policies, offset + 1);
};

type EntityFeatureGateRepairOptions = {
  /** Each relation's gate policy, as the schema owner defines it. */
  readPolicies: () => readonly PolicyDefinition[];
};

const schemaPolicies = (): readonly PolicyDefinition[] =>
  entityFeaturePolicyDefinitions(
    Object.values(schema).filter((table) => is(table, PgTable)),
    POLICY_NAME,
  );

export const createEntityFeatureGateRepair = ({
  readPolicies,
}: EntityFeatureGateRepairOptions): OnlineRepair & {
  // The lifecycle map keys on the literal name.
  readonly name: typeof REPAIR_NAME;
} => ({
  name: REPAIR_NAME,
  readCompletion: async (connection) => {
    const installed = (
      await connection.query(
        `SELECT to_regproc('public.entity_feature_gate_finish') IS NOT NULL AS installed`,
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
      AND bool_and(${CUT_OVER_POLICY}) AS complete
      FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND policyname = '${POLICY_NAME}'
        AND public.entity_feature_gate_graph() ? tablename`);
    const row = rows.at(0);
    if (!isRecord(row) || typeof row["complete"] !== "boolean") {
      return panic("Invalid entity feature cutover state");
    }
    if (row["complete"]) {
      return { type: "complete" };
    }
    const reason =
      "Entity feature gates await backfill and per-relation cutover";
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
    const relations = await readRelations(connection);
    for (const relation of relations) {
      const outcome = await backfillRelation(connection, tables, relation);
      if (outcome.type === "deferred") {
        return outcome;
      }
    }
    // Every relation is backfilled and validated before the first cutover,
    // so a deferred cutover never leaves a relation behind its backfill.
    const policies = new Map(
      readPolicies().map((policy) => [policy.tableName, policy]),
    );
    return await cutOverRelations(
      connection,
      tables,
      relations.map(
        ({ tableName }) =>
          policies.get(tableName) ??
          panic(`Entity feature gate relation ${tableName} has no policy`),
      ),
    );
  },
});

export const ENTITY_FEATURE_GATE_REPAIR = createEntityFeatureGateRepair({
  readPolicies: schemaPolicies,
});
