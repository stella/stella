import { panic } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, isNotNull, like, sql } from "drizzle-orm";

import { entities, fields, properties } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { buildFindConditions } from "@/api/lib/entity-filters";
import { escapeLike } from "@/api/lib/escape-like";
import { isRecord } from "@/api/lib/type-guards";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

/** Enough cells that a scan of them all is not the cheapest plan on offer. */
const ROWS = 3000;
const NAME_PREFIX = "find-plan-";
const NAME_PATTERN = `${escapeLike(NAME_PREFIX)}%`;

let testDb: TestDatabase;
let ids: TestIds;
const propertyId: SafeId<"property"> = createSafeId<"property">();

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb.insert(properties).values({
    id: propertyId,
    workspaceId: ids.wsA1,
    name: "Plan memo",
    content: { version: 1, type: "text" },
    tool: { version: 1, type: "manual-input" },
    status: "fresh",
  });
  // One current version per entity, one text cell per version. A handful of
  // cells carry the needle so the index has something to find.
  await testDb.execute(sql`
    WITH seeded AS (
      SELECT
        gen_random_uuid() AS entity_id,
        gen_random_uuid() AS version_id,
        i
      FROM generate_series(1, ${ROWS}::int) AS i
    ),
    inserted_entities AS (
      INSERT INTO entities (id, workspace_id, kind, name, display_name)
      SELECT entity_id, ${ids.wsA1}::uuid, 'document',
        ${NAME_PREFIX} || i, ${NAME_PREFIX} || i
      FROM seeded
    ),
    inserted_versions AS (
      INSERT INTO entity_versions (id, workspace_id, entity_id)
      SELECT version_id, ${ids.wsA1}::uuid, entity_id FROM seeded
    ),
    inserted_fields AS (
      INSERT INTO fields (id, workspace_id, property_id, entity_version_id, content)
      SELECT gen_random_uuid(), ${ids.wsA1}::uuid, ${propertyId}::uuid, version_id,
        jsonb_build_object(
          'version', 1, 'type', 'text',
          'value', CASE WHEN i % 500 = 0 THEN 'needle clause ' ELSE 'plain memo ' END || i
        )
      FROM seeded
    )
    SELECT count(*) FROM seeded
  `);
  // A separate statement: data-modifying CTEs share one snapshot, so an
  // update in the statement above could not see the rows it inserted.
  await testDb.execute(sql`
    UPDATE entities SET current_version_id = entity_versions.id
    FROM entity_versions
    WHERE entity_versions.entity_id = entities.id
      AND entities.workspace_id = ${ids.wsA1}::uuid
      AND entities.name LIKE ${NAME_PATTERN}
  `);
  await testDb.execute(sql`ANALYZE entities`);
  await testDb.execute(sql`ANALYZE entity_versions`);
  await testDb.execute(sql`ANALYZE fields`);
});

afterAll(async () => {
  try {
    await testDb.delete(fields).where(eq(fields.propertyId, propertyId));
    await testDb
      .delete(entities)
      .where(
        and(
          eq(entities.workspaceId, ids.wsA1),
          like(entities.name, NAME_PATTERN),
        ),
      );
    await testDb.delete(properties).where(eq(properties.id, propertyId));
  } finally {
    await releaseRlsFixture();
  }
});

const planLines = (explained: unknown): string[] => {
  const rows = isRecord(explained) ? explained["rows"] : explained;
  if (!Array.isArray(rows)) {
    return panic("EXPLAIN did not return plan rows");
  }
  return rows.map((row: unknown) => {
    const text = isRecord(row) ? row["QUERY PLAN"] : undefined;
    return typeof text === "string"
      ? text
      : panic("EXPLAIN row has no plan text");
  });
};

/** The base set every table reader scans, narrowed by a find over one column. */
const explainFind = async (term: string): Promise<string> =>
  await testDb.transaction(async (tx) => {
    // The seeded set is small enough that a scan of every cell can still win
    // on cost; the guard is about the shape the planner is offered, which is
    // what production runs at 600k cells.
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const where = and(
      eq(entities.workspaceId, ids.wsA1),
      isNotNull(entities.currentVersionId),
      ...buildFindConditions({
        find: { scope: { propertyIds: [propertyId], type: "columns" }, term },
        workspaceId: ids.wsA1,
      }),
    );
    const explained = await tx.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
        SELECT ${entities.id} FROM ${entities} WHERE ${where}`,
    );
    return planLines(explained).join("\n");
  });

test("a find reads candidate cells off the trigram index, not every cell", async () => {
  const plan = await explainFind("needle");

  expect(plan).not.toMatch(/Seq Scan on fields/u);
  // The subquery is uncorrelated, so the index is probed once for the whole
  // find rather than once per entity.
  expect(plan).toMatch(
    /Bitmap Index Scan on fields_find_text_trgm_idx .*loops=1\)/u,
  );
});

test("the rows the index proposes are the rows the recheck keeps", async () => {
  const rows = await testDb
    .select({ name: entities.name })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, ids.wsA1),
        isNotNull(entities.currentVersionId),
        ...buildFindConditions({
          find: {
            scope: { propertyIds: [propertyId], type: "columns" },
            term: "needle",
          },
          workspaceId: ids.wsA1,
        }),
      ),
    );

  expect(rows.map((row) => row.name).toSorted()).toEqual(
    Array.from(
      { length: ROWS / 500 },
      (_, index) => `${NAME_PREFIX}${(index + 1) * 500}`,
    ).toSorted(),
  );
});
