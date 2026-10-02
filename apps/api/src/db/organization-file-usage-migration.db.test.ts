import { PGlite } from "@electric-sql/pglite";
import { beforeAll, expect, test } from "bun:test";
import { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import {
  organizationFileLedgerPageQuery,
  organizationFileReservationCandidatesQuery,
} from "@/api/lib/files/organization-file-usage-queries";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261003122400_organization_file_usage/migration.sql",
);
const migrationSql = readFileSync(MIGRATION_PATH, "utf-8").replaceAll(
  "--> statement-breakpoint",
  "",
);

// Only the pre-existing objects referenced by this migration belong in the fixture.
const PRE_MIGRATION_SQL = `
  CREATE ROLE stella;
  CREATE TABLE organization (id varchar(128) PRIMARY KEY);
  CREATE TABLE usage_policies (id text PRIMARY KEY);
  INSERT INTO organization VALUES ('fixture-org');
  INSERT INTO usage_policies VALUES ('fixture-policy');
`;

const buildMigratedDatabase = async () => {
  const database = new PGlite();
  await database.exec(PRE_MIGRATION_SQL);
  await database.exec(migrationSql);
  return database;
};

let migratedSnapshot: Blob;

beforeAll(async () => {
  await using template = await buildMigratedDatabase();
  migratedSnapshot = await template.dumpDataDir();
});

const migratedDatabase = async () => await createTestPglite(migratedSnapshot);

const normalizePredicate = (predicate: string | null) =>
  (predicate ?? "")
    .replaceAll('"organization_file_objects".', "")
    .replaceAll('"organization_file_usage".', "")
    .replaceAll(/["()]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();

test("the file usage migration creates the indexes declared by the live schema", async () => {
  const database = await migratedDatabase();
  try {
    const dialect = new PgDialect();
    for (const table of [organizationFileUsage, organizationFileObjects]) {
      const config = getTableConfig(table);
      const expected = config.indexes
        .map(({ config: index }) => {
          if (typeof index.name !== "string") {
            throw new TypeError("Expected an explicitly named index");
          }
          return {
            name: index.name,
            columns: index.columns.map((column) => {
              expect(column instanceof SQL).toBe(false);
              if (!("name" in column) || typeof column.name !== "string") {
                throw new TypeError("Expected a column index");
              }
              return column.name;
            }),
            predicate: normalizePredicate(
              index.where ? dialect.sqlToQuery(index.where).sql : null,
            ),
          };
        })
        .toSorted((left, right) => (left.name < right.name ? -1 : 1));
      const actual = await database.query<{
        name: string;
        columns: string[];
        predicate: string | null;
      }>(
        `
        select index_class.relname as name,
          array(select attribute.attname from unnest(index.indkey) with ordinality as key(attnum, ordinal)
            join pg_attribute attribute on attribute.attrelid = index.indrelid and attribute.attnum = key.attnum
            order by key.ordinal) as columns,
          pg_get_expr(index.indpred, index.indrelid) as predicate
        from pg_index index
        join pg_class index_class on index_class.oid = index.indexrelid
        join pg_class table_class on table_class.oid = index.indrelid
        where table_class.relname = $1 and not index.indisprimary
        order by index_class.relname
      `,
        [config.name],
      );
      expect(
        actual.rows.map((index) => ({
          name: index.name,
          columns: index.columns,
          predicate: normalizePredicate(index.predicate),
        })),
      ).toEqual(expected);
    }
    const existingPolicy = await database.query<{
      id: string;
      storage_bytes_per_assignment: string | null;
    }>("select id, storage_bytes_per_assignment from usage_policies");
    expect(existingPolicy.rows).toEqual([
      { id: "fixture-policy", storage_bytes_per_assignment: null },
    ]);
    const invalidPolicy = await database
      .query("update usage_policies set storage_bytes_per_assignment = -1")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(invalidPolicy).toMatchObject({
      message: expect.stringContaining("usage_policies_storage_bytes_nonneg"),
    });
  } finally {
    await database.close();
  }
});

const planFor = async (
  database: PGlite,
  query: { sql: string; params: unknown[] },
) => {
  const plan = await database.query<{ "QUERY PLAN": string }>(
    `explain (costs off) ${query.sql}`,
    query.params,
  );
  return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
};

test("global tuple pages use keyset indexes and stale claims support ordered scans", async () => {
  const database = await migratedDatabase();
  try {
    await database.exec(`
      insert into organization select 'tenant-' || tenant from generate_series(1, 20) tenant;
      insert into organization_file_objects
        (organization_id, object_key, size_bytes, status, pending_size_bytes, write_id, reservation_started_at, updated_at)
      select 'tenant-' || tenant,
        'tenant-' || tenant || '/file-' || lpad(file::text, 5, '0'),
        1,
        case when file % 3 = 0 then 'reserved' else 'committed' end,
        case when file % 3 = 1 then 2 else null end,
        case when file % 3 < 2 then 'write-' || tenant || '-' || file else null end,
        case when file % 3 < 2 then '2020-01-01'::timestamptz else null end,
        '2020-01-01'::timestamptz + (file || ' seconds')::interval
      from generate_series(1, 20) tenant cross join generate_series(1, 5000) file;
      analyze organization_file_objects;
    `);
    const queryDb = drizzle.mock();
    const organizationId = brandPersistedOrganizationId("tenant-1");
    const firstPage = await planFor(
      database,
      organizationFileLedgerPageQuery({
        db: queryDb,
        cursor: null,
        limit: 200,
      }).toSQL(),
    );
    const cursorPage = await planFor(
      database,
      organizationFileLedgerPageQuery({
        db: queryDb,
        cursor: { organizationId, objectKey: "tenant-1/file-02500" },
        limit: 200,
      }).toSQL(),
    );
    for (const plan of [firstPage, cursorPage]) {
      expect(plan).toContain("organization_file_objects_org_key_idx");
      expect(plan).not.toMatch(/\bSort\b/u);
      expect(plan).not.toContain("Seq Scan");
    }
    const options = {
      db: queryDb,
      staleBefore: new Date("2021-01-01T00:00:00.000Z"),
      retryBefore: new Date("2021-01-01T00:00:00.000Z"),
      limit: 50,
    };
    const globalClaim = await planFor(
      database,
      organizationFileReservationCandidatesQuery(options).toSQL(),
    );
    const tenantClaim = await planFor(
      database,
      organizationFileReservationCandidatesQuery({
        ...options,
        organizationId,
      }).toSQL(),
    );
    expect(globalClaim).toContain(
      "organization_file_objects_pending_reconcile_idx",
    );
    expect(tenantClaim).toContain(
      "organization_file_objects_org_pending_reconcile_idx",
    );
    for (const plan of [globalClaim, tenantClaim]) {
      expect(plan).not.toMatch(/\bSort\b/u);
      expect(plan).not.toContain("Seq Scan");
    }
  } finally {
    await database.close();
  }
});
