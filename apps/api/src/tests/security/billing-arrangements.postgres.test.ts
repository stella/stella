import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(!runPostgresTests)(
  "billing arrangement migration security (postgres)",
  () => {
    test("the migrated arrangement table forces RLS and grants the application operations", async () => {
      expect(databaseUrl).toBeDefined();
      if (!databaseUrl) {
        return;
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const rows = await openClient().db.execute<{
          rls: boolean;
          force: boolean;
          select: boolean;
          insert: boolean;
          update: boolean;
          delete: boolean;
        }>(sql`
      SELECT relation.relrowsecurity AS rls, relation.relforcerowsecurity AS force,
        has_table_privilege('stella', relation.oid, 'SELECT') AS select,
        has_table_privilege('stella', relation.oid, 'INSERT') AS insert,
        has_table_privilege('stella', relation.oid, 'UPDATE') AS update,
        has_table_privilege('stella', relation.oid, 'DELETE') AS delete
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'public.billing_arrangements'::regclass
    `);
        expect(rows).toEqual([
          {
            rls: true,
            force: true,
            select: true,
            insert: true,
            update: true,
            delete: true,
          },
        ]);
      });
    });
  },
);
