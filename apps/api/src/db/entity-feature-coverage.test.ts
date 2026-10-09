import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import {
  foreignKey,
  getTableConfig,
  PgTable,
  pgTable,
  uuid,
} from "drizzle-orm/pg-core";

import { entityFeatureCoverageViolations } from "@/api/db/entity-feature-coverage";
import {
  entityFeaturePolicies,
  entityReferenceClassification,
} from "@/api/db/entity-feature-policies";
import { wsPolicies } from "@/api/db/rls";
import * as schema from "@/api/db/schema";

test("every entity relation retains its classification", () => {
  const tables = Object.values(schema).filter((table) => is(table, PgTable));
  expect(entityFeatureCoverageViolations(tables)).toEqual([]);
});

test("an additional entity reader without the owner fails the census", () => {
  const reader = pgTable(
    "fixture_entity_reader",
    {
      entityId: uuid("entity_id").references(() => schema.entities.id),
    },
    () => wsPolicies(),
  );
  expect(entityFeatureCoverageViolations([reader])).toEqual([
    "fixture_entity_reader.entity_id requires a classified entity relationship",
  ]);
});

test("an indirect projection reader without the owner fails the census", () => {
  const reader = pgTable(
    "fixture_projection_reader",
    {
      entityId: uuid("entity_id").references(
        () => schema.searchDocuments.entityId,
      ),
    },
    () => wsPolicies(),
  );
  expect(entityFeatureCoverageViolations([reader])).toEqual([
    "fixture_projection_reader.entity_id requires a classified entity relationship",
  ]);
});

test("context and owned relationships add no feature policies", () => {
  for (const kind of ["context", "owned-content"] as const) {
    const reader = pgTable(
      "fixture_entity_reader",
      { entityId: uuid("entity_id").references(() => schema.entities.id) },
      (table) =>
        wsPolicies({
          columns: table,
          references: new Map([[table.entityId, { target: "entities", kind }]]),
        }),
    );
    expect(entityFeatureCoverageViolations([reader])).toEqual([]);
    expect(
      getTableConfig(reader).policies.some(
        (policy) => policy.name === "workspace_entity_feature",
      ),
    ).toBe(false);
  }
});

test("parent relationship metadata survives without a feature fence", () => {
  const reader = pgTable(
    "fixture_parent_reader",
    {
      runId: uuid("run_id").references(() => schema.documentTranslationRuns.id),
    },
    (table) => [
      ...wsPolicies(),
      ...entityFeaturePolicies(
        table,
        new Map([
          [
            table.runId,
            {
              kind: "owned-by-parent",
              parent: schema.documentTranslationRuns,
            },
          ],
        ]),
      ),
    ],
  );
  expect(
    getTableConfig(reader).policies.some(
      (policy) => policy.name === "workspace_entity_feature",
    ),
  ).toBe(false);
  expect(entityReferenceClassification(reader.runId)).toEqual({
    kind: "owned-by-parent",
    parent: schema.documentTranslationRuns,
  });
});

test("the committed drop migration removes every original visibility policy", async () => {
  const original = await Bun.file(
    new URL(
      "../../drizzle/20261007090200_entity_feature_visibility/migration.sql",
      import.meta.url,
    ),
  ).text();
  const migration = await Bun.file(
    new URL(
      "../../drizzle/20261008160100_drop_entity_feature_policies/migration.sql",
      import.meta.url,
    ),
  ).text();
  const createdTables = [
    ...original.matchAll(
      /CREATE POLICY "workspace_entity_feature" ON "public"\."([^"]+)"/gu,
    ),
  ].map((match) => match[1]);
  const droppedTables = [
    ...migration.matchAll(
      /DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"\."([^"]+)";/gu,
    ),
  ].map((match) => match[1]);
  expect(createdTables).toHaveLength(47);
  expect(droppedTables).toEqual(createdTables);
  const tables = Object.values(schema).filter((table) => is(table, PgTable));
  expect(
    tables.flatMap((table) =>
      getTableConfig(table).policies.filter(
        (policy) => policy.name === "workspace_entity_feature",
      ),
    ),
  ).toEqual([]);
});

test("a composite entity relationship also requires a classification", () => {
  const reader = pgTable(
    "fixture_composite_reader",
    {
      entityId: uuid("entity_id"),
      workspaceId: uuid("workspace_id"),
    },
    (table) => [
      foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [schema.entities.id, schema.entities.workspaceId],
      }),
      ...wsPolicies(),
    ],
  );
  expect(entityFeatureCoverageViolations([reader])).toEqual([
    "fixture_composite_reader.entity_id requires a classified entity relationship",
  ]);
});
