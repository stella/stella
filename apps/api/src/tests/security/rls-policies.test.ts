import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural test: every table with a `safeWorkspaceId` column
 * must have a corresponding RLS policy in the migration file.
 * Fails CI if a new workspace-scoped table is added without RLS.
 */

const SCHEMA_PATH = resolve(import.meta.dir, "../../db/schema.ts");
const MIGRATION_PATH = resolve(
  import.meta.dir,
  "../../../drizzle/0001_workspace_rls.sql",
);

/** No tables are exempt: every table with a workspace_id column
 *  must have its own RLS policy. Relying on FK joins through a
 *  parent table is an application convention, not a database
 *  guarantee; a direct query by ID bypasses the parent filter. */
const RLS_EXEMPT_TABLES = new Set<string>();

describe("RLS policies", () => {
  test("every workspace-scoped table has an RLS policy", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const migration = readFileSync(MIGRATION_PATH, "utf8");

    // Find table names containing safeWorkspaceId by looking
    // backwards from each safeWorkspaceId call to the nearest
    // pgTable declaration.
    const tableDecls = [...schema.matchAll(/p\.pgTable\(\s*"([^"]+)"/g)];
    const wsIdCalls = [...schema.matchAll(/safeWorkspaceId\(/g)];

    const tablesWithWorkspaceId = [
      ...new Set(
        wsIdCalls
          .map((call) => {
            const callIdx = call.index ?? 0;
            const preceding = tableDecls.filter(
              (d) => (d.index ?? 0) < callIdx,
            );
            return preceding.at(-1)?.[1];
          })
          .filter(Boolean) as string[],
      ),
    ];

    expect(tablesWithWorkspaceId.length).toBeGreaterThan(0);

    const missing: string[] = [];

    for (const table of tablesWithWorkspaceId) {
      if (RLS_EXEMPT_TABLES.has(table)) {
        continue;
      }

      const hasEnableRLS = migration.includes(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      );
      const hasPolicy = migration.includes(`ON ${table}`);

      if (!hasEnableRLS || !hasPolicy) {
        missing.push(table);
      }
    }

    expect(missing).toEqual([]);
  });

  test("RLS is enabled on the workspaces table itself", () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    expect(migration).toContain(
      "ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("ON workspaces");
  });
});
