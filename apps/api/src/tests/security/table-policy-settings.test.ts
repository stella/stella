import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { TABLE_POLICY_SETTINGS_BASELINE } from "@/api/tests/security/table-policy-settings-baseline";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const readTablePolicySettings = async (): Promise<string[]> => {
  const rows = await rootDb.execute<{ name: string }>(sql`
    SELECT relation.relname AS name
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
    ORDER BY relation.relname
  `);
  return rows.map(({ name }) => name);
};

if (!runPostgresTests) {
  describe.skip("table policy settings baseline", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgresTests).toBe(false);
    });
  });
} else {
  describe("table policy settings baseline", () => {
    test("matches the migrated catalog", async () => {
      const current = new Set(await readTablePolicySettings());
      const baseline = new Set(TABLE_POLICY_SETTINGS_BASELINE);

      // New entries: set the table's policy setting in its migration, or add
      // it to the baseline in a reviewed change.
      expect([...current].filter((name) => !baseline.has(name))).toEqual([]);
      // Stale entries: the setting changed; remove the table from the list.
      expect([...baseline].filter((name) => !current.has(name))).toEqual([]);
    });
  });
}
