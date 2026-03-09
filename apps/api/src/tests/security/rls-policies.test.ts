import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

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

/** Tables that have `safeWorkspaceId` but don't need their own
 *  RLS policy because they're only reachable through FK joins
 *  on an already-filtered parent table (e.g., entity_versions
 *  via entities). This set should shrink over time as we add
 *  RLS to more tables for defense in depth. */
const RLS_EXEMPT_TABLES = new Set([
  "entity_versions",
  "fields",
  "justifications",
  "extracted_content",
  "property_dependencies",
]);

describe("RLS policies", () => {
  test("every workspace-scoped table has an RLS policy", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    const migration = readFileSync(MIGRATION_PATH, "utf-8");

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
    const migration = readFileSync(MIGRATION_PATH, "utf-8");
    expect(migration).toContain(
      "ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("ON workspaces");
  });
});
