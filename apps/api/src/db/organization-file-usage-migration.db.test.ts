import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";

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

const migratedDatabase = async () => {
  const database = new PGlite();
  await database.exec(PRE_MIGRATION_SQL);
  await database.exec(migrationSql);
  return database;
};

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

const planFor = async (database: PGlite, query: string) => {
  const plan = await database.query<{ "QUERY PLAN": string }>(
    `explain (costs off) ${query}`,
  );
  return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
};

test("tenant pages use keyset indexes and stale claims support ordered scans", async () => {
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
    const firstPage = await planFor(
      database,
      `select object_key from organization_file_objects where organization_id = 'tenant-1' order by object_key limit 200`,
    );
    const cursorPage = await planFor(
      database,
      `select object_key from organization_file_objects where organization_id = 'tenant-1' and object_key > 'tenant-1/file-02500' order by object_key limit 200`,
    );
    for (const plan of [firstPage, cursorPage]) {
      expect(plan).toContain("organization_file_objects_org_key_idx");
      expect(plan).not.toMatch(/\bSort\b/u);
      expect(plan).not.toContain("Seq Scan");
    }
    const staleQuery = `select object_key from organization_file_objects
      where write_id is not null and (status = 'reserved' or (status = 'committed' and pending_size_bytes is not null))
      and reservation_started_at <= '2021-01-01'::timestamptz and updated_at <= '2021-01-01'::timestamptz`;
    const globalClaim = await planFor(
      database,
      `${staleQuery} order by updated_at, object_key limit 50`,
    );
    const tenantClaim = await planFor(
      database,
      `${staleQuery} and organization_id = 'tenant-1' order by updated_at, object_key limit 50`,
    );
    expect(globalClaim).toContain(
      "organization_file_objects_pending_reconcile_idx",
    );
    expect(tenantClaim).toContain(
      "organization_file_objects_org_pending_reconcile_idx",
    );
    // This small fixture can favor a bitmap scan and sort for one tenant.
    // Separately prove that both indexes can supply the requested order.
    await database.exec(
      "set enable_bitmapscan = off; set enable_seqscan = off",
    );
    const orderedTenantClaim = await planFor(
      database,
      `${staleQuery} and organization_id = 'tenant-1' order by updated_at, object_key limit 50`,
    );
    expect(orderedTenantClaim).toContain(
      "organization_file_objects_org_pending_reconcile_idx",
    );
    for (const plan of [globalClaim, orderedTenantClaim]) {
      expect(plan).not.toMatch(/\bSort\b/u);
      expect(plan).not.toContain("Seq Scan");
    }
  } finally {
    await database.close();
  }
});
