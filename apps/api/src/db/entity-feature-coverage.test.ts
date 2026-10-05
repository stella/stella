import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable, pgTable, uuid } from "drizzle-orm/pg-core";

import { entityFeatureCoverageViolations } from "@/api/db/entity-feature-coverage";
import { entityFeaturePolicies } from "@/api/db/entity-feature-policies";
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
