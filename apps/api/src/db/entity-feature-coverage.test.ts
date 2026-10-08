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
  entityFeaturePolicyStatements,
} from "@/api/db/entity-feature-policies";
import { wsPolicies } from "@/api/db/rls";
import * as schema from "@/api/db/schema";

test("every app-readable entity relation inherits feature visibility", () => {
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

test("context rows remain visible while owned content inherits visibility", () => {
  const context = pgTable(
    "fixture_context_reader",
    { entityId: uuid("entity_id").references(() => schema.entities.id) },
    (table) =>
      wsPolicies({
        columns: table,
        references: new Map([
          [table.entityId, { target: "entities", kind: "context" }],
        ]),
      }),
  );
  const owned = pgTable(
    "fixture_owned_reader",
    { entityId: uuid("entity_id").references(() => schema.entities.id) },
    (table) =>
      wsPolicies({
        columns: table,
        references: new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      }),
  );
  expect(entityFeatureCoverageViolations([context, owned])).toEqual([]);
  const policies = getTableConfig(owned).policies;
  const withoutOwner = policies.filter(
    (policy) => policy.name !== "workspace_entity_feature",
  );
  const unprotected = pgTable(
    "fixture_owned_reader",
    { entityId: uuid("entity_id").references(() => schema.entities.id) },
    (table) => {
      entityFeaturePolicies(
        table,
        new Map([
          [table.entityId, { target: "entities", kind: "owned-content" }],
        ]),
      );
      return withoutOwner;
    },
  );
  expect(entityFeatureCoverageViolations([unprotected])).toEqual([
    "fixture_owned_reader.entity_id requires the entity feature owner",
  ]);
});

test("a record owned by a fenced parent row inherits the parent's visibility", () => {
  const unfenced = pgTable(
    "fixture_parent_reader",
    {
      runId: uuid("run_id").references(() => schema.documentTranslationRuns.id),
    },
    () => wsPolicies(),
  );
  expect(entityFeatureCoverageViolations([unfenced])).toEqual([
    "fixture_parent_reader.run_id requires a classified parent relationship",
  ]);
  const misattributed = pgTable(
    "fixture_parent_reader",
    {
      runId: uuid("run_id").references(() => schema.documentTranslationRuns.id),
    },
    (table) =>
      wsPolicies({
        columns: table,
        references: new Map([
          [
            table.runId,
            { kind: "owned-by-parent", parent: schema.correspondence },
          ],
        ]),
      }),
  );
  expect(entityFeatureCoverageViolations([misattributed])).toEqual([
    "fixture_parent_reader.run_id requires a classified parent relationship",
  ]);
  const fenced = pgTable(
    "fixture_parent_reader",
    {
      runId: uuid("run_id").references(() => schema.documentTranslationRuns.id),
    },
    (table) =>
      wsPolicies({
        columns: table,
        references: new Map([
          [
            table.runId,
            {
              kind: "owned-by-parent",
              parent: schema.documentTranslationRuns,
            },
          ],
        ]),
      }),
  );
  expect(entityFeatureCoverageViolations([fenced])).toEqual([]);
  const withoutFence = getTableConfig(fenced).policies.filter(
    (policy) => policy.name !== "workspace_entity_feature",
  );
  const unprotected = pgTable(
    "fixture_parent_reader",
    {
      runId: uuid("run_id").references(() => schema.documentTranslationRuns.id),
    },
    (table) => {
      entityFeaturePolicies(
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
      );
      return withoutFence;
    },
  );
  expect(entityFeatureCoverageViolations([unprotected])).toEqual([
    "fixture_parent_reader.run_id requires the parent feature fence",
  ]);
});

test("a record owned by an unfenced parent needs no fence", () => {
  const reader = pgTable(
    "fixture_unfenced_parent_reader",
    {
      workspaceId: uuid("workspace_id").references(() => schema.workspaces.id),
    },
    () => wsPolicies(),
  );
  expect(entityFeatureCoverageViolations([reader])).toEqual([]);
});

test("the committed migration matches every schema-owned visibility policy", async () => {
  const migration = await Bun.file(
    new URL(
      "../../drizzle/20261007090200_entity_feature_visibility/migration.sql",
      import.meta.url,
    ),
  ).text();
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith("CREATE POLICY"));
  const tables = Object.values(schema).filter((table) => is(table, PgTable));
  expect(statements).toEqual(entityFeaturePolicyStatements(tables));
  expect(
    statements.some((statement) =>
      statement.includes('ON "public"."time_entries"'),
    ),
  ).toBe(false);
  expect(
    statements.some((statement) =>
      statement.includes('ON "public"."expenses"'),
    ),
  ).toBe(false);
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
