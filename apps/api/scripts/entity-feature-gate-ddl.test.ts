import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { entityFeatureGateMetadata } from "../src/db/entity-feature-gate-metadata";
import {
  effectiveEntityFeatureGateDefinitions,
  readEffectiveEntityFeatureGateDefinitions,
  readEntityFeatureGateMigrationTexts,
} from "../src/db/entity-feature-gate-migrations";
import { entityFeaturePolicyDefinitions } from "../src/db/entity-feature-policies";
import * as schema from "../src/db/schema";
import { createPolicyStatementsOf } from "../src/tests/helpers/lock-taking-sql";
import {
  createPolicyStatement,
  entityFeatureGatePieces,
  entityFeatureGateTableSql,
} from "./entity-feature-gate-ddl";

const tables = Object.values(schema).filter((table) => is(table, PgTable));
const descriptors = entityFeatureGateMetadata(tables);

test("today's schema needs no gate DDL", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  expect(entityFeatureGateTableSql(tables, descriptors, effective)).toEqual([]);
});

// A new table's schema migration creates its visibility policies (declared by
// `entityFeaturePolicies`) but not the gate triggers or the gate role's
// grants; a policy is no evidence of the rest.
test("a table with its policies but no triggers or grants still gets them", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const table = "legal_list_item_sources";
  const statements = entityFeatureGateTableSql(tables, descriptors, {
    ...effective,
    triggers: new Map(
      [...effective.triggers].filter(([key]) => !key.startsWith(`${table}.`)),
    ),
    grants: new Map([...effective.grants].filter(([key]) => key !== table)),
  }).join("\n");

  expect(statements).toContain(
    `CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."${table}"`,
  );
  expect(statements).toContain(
    `CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."${table}"`,
  );
  expect(statements).toContain(`ON public."${table}" TO stella_entity_gate;`);
  expect(statements).not.toContain("CREATE POLICY");
});

test("a CREATE-then-DROP write-trigger history restores the trigger", async () => {
  const table = "legal_list_item_sources";
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const history = effectiveEntityFeatureGateDefinitions([
    `CREATE TRIGGER entity_feature_gate_write BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION entity_feature_gate_write(); DROP TRIGGER entity_feature_gate_write ON ${table};`,
  ]);
  const triggers = new Map(effective.triggers);
  if (!history.triggers.has(`${table}.entity_feature_gate_write`)) {
    triggers.delete(`${table}.entity_feature_gate_write`);
  }
  const statements = entityFeatureGateTableSql(tables, descriptors, {
    ...effective,
    triggers,
  });
  expect(statements.join("\n")).toContain(
    `CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."${table}"`,
  );
});

test("a dropped parent propagation trigger is restored", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const history = effectiveEntityFeatureGateDefinitions([
    `CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON entities FOR EACH STATEMENT EXECUTE FUNCTION entity_feature_gate_propagate(); DROP TRIGGER entity_feature_gate_update ON entities;`,
  ]);
  const triggers = new Map(effective.triggers);
  if (!history.triggers.has("entities.entity_feature_gate_update")) {
    triggers.delete("entities.entity_feature_gate_update");
  }
  const statements = entityFeatureGateTableSql(tables, descriptors, {
    ...effective,
    triggers,
  });
  expect(statements.join("\n")).toContain(
    'CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."entities"',
  );
});

test("a dropped maintenance grant is restored", async () => {
  const table = "legal_list_item_sources";
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const history = effectiveEntityFeatureGateDefinitions([
    `GRANT SELECT (id), UPDATE (entity_feature_gate) ON ${table} TO stella_entity_gate; REVOKE SELECT ON ${table} FROM stella_entity_gate;`,
  ]);
  const grants = new Map(effective.grants);
  if (!history.grants.has(table)) {
    grants.delete(table);
  }
  const statements = entityFeatureGateTableSql(tables, descriptors, {
    ...effective,
    grants,
  });
  expect(statements.join("\n")).toContain(
    `ON public."${table}" TO stella_entity_gate;`,
  );
});

// The gate migration created the row-gate routines as the gate role, and
// only a routine's owner may replace it or change its privileges.
// One test per piece state; each piece is judged and repaired on its own.

test("present: every piece of today's schema is present", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const pieces = entityFeatureGatePieces(tables, descriptors, effective);
  expect(pieces.length).toBeGreaterThan(0);
  expect(pieces.filter(({ state }) => state !== "present")).toEqual([]);
});

test("absent: a missing gate-role routine is recreated as its owner", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const functions = new Map(effective.functions);
  functions.delete("entity_feature_gate_propagate");
  expect(
    entityFeatureGateTableSql(tables, descriptors, { ...effective, functions }),
  ).toEqual(
    expect.arrayContaining([
      "SET LOCAL ROLE stella_entity_gate;",
      expect.stringMatching(
        /^CREATE OR REPLACE FUNCTION public\.entity_feature_gate_propagate\(\)/u,
      ),
      "RESET ROLE;",
    ]),
  );
});

test("stale: a changed routine is replaced, as its owner when the gate role owns it", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const functions = new Map(effective.functions);
  functions.set(
    "entity_feature_gate_graph",
    "CREATE OR REPLACE FUNCTION public.entity_feature_gate_graph() older",
  );
  functions.set(
    "entity_feature_gate_propagate",
    "CREATE OR REPLACE FUNCTION public.entity_feature_gate_propagate() older",
  );
  const pieces = entityFeatureGatePieces(tables, descriptors, {
    ...effective,
    functions,
  });
  const graph = pieces.find(
    ({ id }) => id === "routine:entity_feature_gate_graph",
  );
  const propagate = pieces.find(
    ({ id }) => id === "routine:entity_feature_gate_propagate",
  );
  expect(graph?.state).toBe("stale");
  expect(graph?.repair).toHaveLength(1);
  expect(propagate?.state).toBe("stale");
  expect(propagate?.repair.at(0)).toBe("SET LOCAL ROLE stella_entity_gate;");
  expect(propagate?.repair.at(-1)).toBe("RESET ROLE;");
});

test("over-granted: an unchanged routine PUBLIC may execute again is revoked as its owner", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const revokes = new Set(effective.revokes);
  revokes.delete("entity_feature_gate_propagate()");
  expect(
    entityFeatureGateTableSql(tables, descriptors, { ...effective, revokes }),
  ).toEqual([
    "SET LOCAL ROLE stella_entity_gate;",
    "REVOKE ALL ON FUNCTION public.entity_feature_gate_propagate() FROM PUBLIC;",
    "RESET ROLE;",
  ]);
});

test("disabled: a disabled trigger is enabled, never created again", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const key = "legal_list_item_sources.entity_feature_gate_write";
  const triggers = new Map(effective.triggers);
  triggers.delete(key);
  expect(
    entityFeatureGateTableSql(tables, descriptors, {
      ...effective,
      triggers,
      disabledTriggers: new Set([key]),
    }),
  ).toEqual([
    'ALTER TABLE public."legal_list_item_sources" ENABLE TRIGGER entity_feature_gate_write;',
  ]);
});

test("absent index: a complete table that lost only a gate index gets that index back", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const key = [...effective.indexes.keys()].at(0) ?? "";
  expect(key).not.toBe("");
  const indexes = new Map(effective.indexes);
  indexes.delete(key);
  const statements = entityFeatureGateTableSql(tables, descriptors, {
    ...effective,
    indexes,
  });
  expect(statements).toHaveLength(1);
  expect(statements.at(0)).toContain(
    `INDEX CONCURRENTLY "${key.slice(key.indexOf(".") + 1)}"`,
  );
});

test("the generator spells every gate policy exactly as online DDL does", async () => {
  for (const policyName of [
    "workspace_entity_feature",
    "entity_feature_gate_maintenance",
  ]) {
    const policies = entityFeaturePolicyDefinitions(tables, policyName);
    expect(policies.map(createPolicyStatement)).toEqual(
      await createPolicyStatementsOf(policies),
    );
  }
});

test("a trigger history leaves in REPLICA mode is repaired to plain ENABLE", async () => {
  const statements = entityFeatureGateTableSql(
    tables,
    descriptors,
    effectiveEntityFeatureGateDefinitions([
      ...(await readEntityFeatureGateMigrationTexts()),
      'ALTER TABLE public."legal_list_item_sources" ENABLE REPLICA TRIGGER entity_feature_gate_write;',
    ]),
  );
  expect(statements).toEqual([
    'ALTER TABLE public."legal_list_item_sources" ENABLE TRIGGER entity_feature_gate_write;',
  ]);
});
