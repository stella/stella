import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable, pgTable, uuid } from "drizzle-orm/pg-core";

import { entityFeatureCoverageViolations } from "@/api/db/entity-feature-coverage";
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
    "fixture_entity_reader.entity_id requires the entity feature owner",
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
    "fixture_projection_reader.entity_id requires the entity feature owner",
  ]);
});
