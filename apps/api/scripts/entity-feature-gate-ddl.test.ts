import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { entityFeatureGateMetadata } from "../src/db/entity-feature-gate-metadata";
import { readEffectiveEntityFeatureGateDefinitions } from "../src/db/entity-feature-gate-migrations";
import * as schema from "../src/db/schema";
import { entityFeatureGateTableSql } from "./entity-feature-gate-ddl";

const tables = Object.values(schema).filter((table) => is(table, PgTable));
const descriptors = entityFeatureGateMetadata(tables);

test("today's schema needs no gate DDL", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  expect(
    await entityFeatureGateTableSql(tables, descriptors, effective),
  ).toEqual([]);
});

// A new table's schema migration creates its visibility policies (declared by
// `entityFeaturePolicies`) but not the gate triggers or the gate role's
// grants; a policy is no evidence of the rest.
test("a table with its policies but no triggers or grants still gets them", async () => {
  const effective = await readEffectiveEntityFeatureGateDefinitions();
  const table = "legal_list_item_sources";
  const statements = (
    await entityFeatureGateTableSql(tables, descriptors, {
      ...effective,
      triggers: new Map(
        [...effective.triggers].filter(([key]) => !key.startsWith(`${table}.`)),
      ),
      grants: new Map([...effective.grants].filter(([key]) => key !== table)),
    })
  ).join("\n");

  expect(statements).toContain(
    `CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."${table}"`,
  );
  expect(statements).toContain(
    `CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."${table}"`,
  );
  expect(statements).toContain(`ON public."${table}" TO stella_entity_gate;`);
  expect(statements).not.toContain("CREATE POLICY");
});
