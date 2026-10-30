import { panic } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";

import { ENTITY_FIND_SCOPE_TYPES } from "@stll/api-contract";
import type { EntityFindScopeType } from "@stll/api-contract";

import { entities, fields, properties } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { buildFindConditions } from "@/api/lib/entity-filters";
import { escapeLike } from "@/api/lib/escape-like";
import { isRecord } from "@/api/lib/type-guards";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

/**
 * The matter-table find as production runs it: on the application role, under
 * the row policies, with one matter in scope. The fixture connection owns the
 * tables and bypasses those policies, so every find here goes through
 * `scopedQuery`; a plan read as the owner is one production never runs.
 */

setDefaultTimeout(120_000);

/** Rows in the matter the find runs in. */
const ROWS = 3000;
/**
 * Rows in another organization's matter. Production holds many tenants'
 * cells; with the found matter a minority of the table, reading every
 * findable cell is a plan the planner would only pick if nothing narrower
 * were on offer.
 */
const NEIGHBOUR_ROWS = 3 * ROWS;
const NAME_PREFIX = "find-plan-";
const NAME_PATTERN = `${escapeLike(NAME_PREFIX)}%`;

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: Awaited<ReturnType<typeof getRlsFixture>>["scopedQuery"];
const propertyId: SafeId<"property"> = createSafeId<"property">();
const neighbourPropertyId: SafeId<"property"> = createSafeId<"property">();

/**
 * One current version per entity, one text cell per version. Every 500th
 * cell carries the needle, accented, so the find has something to return.
 */
const seedMatter = async (
  workspaceId: SafeId<"workspace">,
  memoId: SafeId<"property">,
  rows: number,
): Promise<void> => {
  await testDb.insert(properties).values({
    id: memoId,
    workspaceId,
    name: "Plan memo",
    content: { version: 1, type: "text" },
    tool: { version: 1, type: "manual-input" },
    status: "fresh",
  });
  await testDb.execute(sql`
    WITH seeded AS (
      SELECT
        gen_random_uuid() AS entity_id,
        gen_random_uuid() AS version_id,
        i
      FROM generate_series(1, ${rows}::int) AS i
    ),
    inserted_entities AS (
      INSERT INTO entities (id, workspace_id, kind, name, display_name)
      SELECT entity_id, ${workspaceId}::uuid, 'document',
        ${NAME_PREFIX} || i, ${NAME_PREFIX} || i
      FROM seeded
    ),
    inserted_versions AS (
      INSERT INTO entity_versions (id, workspace_id, entity_id)
      SELECT version_id, ${workspaceId}::uuid, entity_id FROM seeded
    ),
    inserted_fields AS (
      INSERT INTO fields (id, workspace_id, property_id, entity_version_id, content)
      SELECT gen_random_uuid(), ${workspaceId}::uuid, ${memoId}::uuid, version_id,
        jsonb_build_object(
          'version', 1, 'type', 'text',
          'value', CASE WHEN i % 500 = 0 THEN 'Needlé clause ' ELSE 'plain memo ' END || i
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
      AND entities.workspace_id = ${workspaceId}::uuid
      AND entities.name LIKE ${NAME_PATTERN}
  `);
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;

  await seedMatter(ids.wsA1, propertyId, ROWS);
  await seedMatter(ids.wsB1, neighbourPropertyId, NEIGHBOUR_ROWS);
  await testDb.execute(sql`ANALYZE entities`);
  await testDb.execute(sql`ANALYZE entity_versions`);
  await testDb.execute(sql`ANALYZE fields`);
});

afterAll(async () => {
  try {
    const memoIds = [propertyId, neighbourPropertyId];
    await testDb.delete(fields).where(inArray(fields.propertyId, memoIds));
    await testDb
      .delete(entities)
      .where(
        and(
          inArray(entities.workspaceId, [ids.wsA1, ids.wsB1]),
          like(entities.name, NAME_PATTERN),
        ),
      );
    await testDb.delete(properties).where(inArray(properties.id, memoIds));
  } finally {
    await releaseRlsFixture();
  }
});

type PlanNode = {
  indexCond: string | undefined;
  indexName: string | undefined;
  loops: number;
  nodeType: string;
  relationName: string | undefined;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const planNodes = (node: unknown): PlanNode[] => {
  if (!isRecord(node)) {
    return [];
  }
  const loops = node["Actual Loops"];
  const children = Array.isArray(node["Plans"]) ? node["Plans"] : [];
  return [
    {
      indexCond: optionalString(node["Index Cond"]),
      indexName: optionalString(node["Index Name"]),
      loops:
        typeof loops === "number"
          ? loops
          : panic("EXPLAIN ANALYZE node has no loop count"),
      nodeType: String(node["Node Type"]),
      relationName: optionalString(node["Relation Name"]),
    },
    ...children.flatMap(planNodes),
  ];
};

/** The base set every table reader scans, narrowed by a find over one column. */
const findWhere = (term: string, type: EntityFindScopeType) =>
  and(
    eq(entities.workspaceId, ids.wsA1),
    isNotNull(entities.currentVersionId),
    ...buildFindConditions({
      find: { scope: { propertyIds: [propertyId], type }, term },
      scope: { type: "matter", workspaceId: ids.wsA1 },
    }),
  );

/** A transaction on the application role, scoped to the found matter. */
const inMatter = async <T>(
  fn: (tx: TestDatabaseTransaction) => Promise<T>,
): Promise<T> => await scopedQuery([ids.wsA1], ids.orgA, fn);

/** The nodes of the find's executed plan, run as the application role. */
const explainFind = async (
  term: string,
  type: EntityFindScopeType,
): Promise<PlanNode[]> =>
  await inMatter(async (tx) => {
    // The seeded set is small enough that a scan of every cell can still win
    // on cost; the guard is about the shape the planner is offered, which is
    // what production runs at 600k cells.
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const row = executedRows(
      await tx.execute(
        sql`EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON)
          SELECT ${entities.id} FROM ${entities} WHERE ${findWhere(term, type)}`,
      ),
    ).at(0);
    const plan = isRecord(row) ? row["QUERY PLAN"] : undefined;
    const document = Array.isArray(plan) ? plan.at(0) : undefined;
    return isRecord(document)
      ? planNodes(document["Plan"])
      : panic("Find EXPLAIN returned no plan");
  });

const fieldsIndexNames = async (): Promise<Set<string>> =>
  new Set(
    executedRows(
      await testDb.execute(
        sql`SELECT indexname FROM pg_catalog.pg_indexes
          WHERE schemaname = 'public' AND tablename = 'fields'`,
      ),
    ).map((row) =>
      isRecord(row) && typeof row["indexname"] === "string"
        ? row["indexname"]
        : panic("pg_indexes row has no index name"),
    ),
  );

// Both scopes: `columns` is the subquery alone, which Postgres may turn into
// a join even when correlated; `all` ORs it with the name, where it stays a
// subplan, so there only an uncorrelated subquery runs once.
test.each(ENTITY_FIND_SCOPE_TYPES)(
  "scope %s: a find under row policies reads the matter's cells once, by workspace",
  async (type) => {
    const nodes = await explainFind("needle", type);
    const fieldsIndexes = await fieldsIndexNames();
    const cellReads = nodes.filter(
      ({ indexName, relationName }) =>
        relationName === "fields" ||
        (indexName !== undefined && fieldsIndexes.has(indexName)),
    );
    const indexReads = cellReads.filter(
      ({ indexName }) => indexName !== undefined,
    );

    // The subquery is uncorrelated, so the matter's cells are read once for the
    // whole find rather than once per entity.
    expect(cellReads.map(({ loops }) => loops)).toEqual(cellReads.map(() => 1));
    // Never a scan of every tenant's cells: no sequential scan, and every index
    // read of `fields` is keyed on the workspace the find is scoped to. Row
    // policies keep a find operator from reaching an index, so the workspace is
    // the only key that bounds the read.
    expect(cellReads.map(({ nodeType }) => nodeType)).not.toContain("Seq Scan");
    expect(indexReads).not.toEqual([]);
    for (const { indexCond } of indexReads) {
      expect(indexCond ?? "").toMatch(/\bworkspace_id = /u);
    }
  },
);

test.each(ENTITY_FIND_SCOPE_TYPES)(
  "scope %s: a find returns the matter's rows whose cell matches, whatever the accents",
  async (type) => {
    const rows = await inMatter(
      async (tx) =>
        await tx
          .select({ name: entities.name })
          .from(entities)
          .where(findWhere("needle", type)),
    );

    expect(rows.map((row) => row.name).toSorted()).toEqual(
      Array.from(
        { length: ROWS / 500 },
        (_, index) => `${NAME_PREFIX}${(index + 1) * 500}`,
      ).toSorted(),
    );
  },
);
