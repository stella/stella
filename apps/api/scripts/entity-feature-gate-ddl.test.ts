import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { entityFeatureGateMetadata } from "../src/db/entity-feature-gate-metadata";
import {
  effectiveEntityFeatureGateDefinitions,
  readEffectiveEntityFeatureGateDefinitions,
} from "../src/db/entity-feature-gate-migrations";
import { entityFeaturePolicyDefinitions } from "../src/db/entity-feature-policies";
import * as schema from "../src/db/schema";
import { createPolicyStatementsOf } from "../src/tests/helpers/lock-taking-sql";
import {
  createPolicyStatement,
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
test("a missing gate-role routine is recreated as its owner, with its revoke", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const functions = new Map(effective.functions);
  functions.delete("entity_feature_gate_propagate");
  const statements = entityFeatureGateTableSql(tables, descriptors, {
    ...effective,
    functions,
  });
  const create = statements.findIndex((statement) =>
    statement.startsWith(
      "CREATE OR REPLACE FUNCTION public.entity_feature_gate_propagate()",
    ),
  );
  expect(create).toBeGreaterThan(0);
  expect(statements.at(create - 1)).toBe("SET LOCAL ROLE stella_entity_gate;");
  expect(statements.slice(create + 1, create + 3)).toEqual(
    effective.revokes.has("entity_feature_gate_propagate()")
      ? ["RESET ROLE;"]
      : [
          "REVOKE ALL ON FUNCTION public.entity_feature_gate_propagate() FROM PUBLIC;",
          "RESET ROLE;",
        ],
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
