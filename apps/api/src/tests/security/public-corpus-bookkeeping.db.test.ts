import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { PUBLIC_CORPUS_BOOKKEEPING_TABLES } from "@/api/lib/public-corpus-bookkeeping";
import {
  verifyPublicCorpusCatalog,
  type PublicCorpusCatalogPosture,
} from "@/api/lib/public-corpus-bookkeeping-verification";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("public corpus category migrated privileges", () => {
  test("verifies every member after the PR's migrations are applied", async () => {
    for (const entry of PUBLIC_CORPUS_BOOKKEEPING_TABLES) {
      const rows = await rootDb.execute<PublicCorpusCatalogPosture>(sql`
        SELECT relation.relname AS name, relation.relkind::text AS kind,
          relation.relrowsecurity AS enabled, relation.relforcerowsecurity AS forced,
          (
            has_table_privilege('stella', relation.oid,
              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
            OR has_any_column_privilege('stella', relation.oid,
              'SELECT, INSERT, UPDATE, REFERENCES')
          ) AS "appPrivileges",
          EXISTS (
            SELECT 1 FROM pg_catalog.pg_trigger trigger
            WHERE trigger.tgrelid = relation.oid AND NOT trigger.tgisinternal
          ) AS "userTriggers",
          EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint dependent
            WHERE dependent.contype = 'f' AND dependent.confrelid = relation.oid
              AND (dependent.confdeltype IN ('c', 'n', 'd')
                OR dependent.confupdtype IN ('c', 'n', 'd'))
          ) AS "cascadingDependents",
          COALESCE((SELECT json_agg(json_build_object(
            'command', policy.polcmd::text,
            'publicOnly', policy.polroles = ARRAY[0::oid],
            'permissive', policy.polpermissive,
            'using', pg_get_expr(policy.polqual, policy.polrelid),
            'check', pg_get_expr(policy.polwithcheck, policy.polrelid)
          )) FROM pg_catalog.pg_policy policy WHERE policy.polrelid = relation.oid), '[]'::json) AS policies
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = ${entry.sqlName}
      `);
      expect(verifyPublicCorpusCatalog(rows.at(0))).toEqual([]);
    }
  });
});
