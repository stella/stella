import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { executedRows } from "@/api/lib/db/executed-rows";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

const RELATION_KIND = {
  TABLE: "r",
  MATERIALIZED_VIEW: "m",
} as const;

type Relation = {
  name: string;
  kind: (typeof RELATION_KIND)[keyof typeof RELATION_KIND];
};

const isRelation = (row: unknown): row is Relation =>
  typeof row === "object" &&
  row !== null &&
  "name" in row &&
  typeof row.name === "string" &&
  "kind" in row &&
  (row.kind === RELATION_KIND.TABLE ||
    row.kind === RELATION_KIND.MATERIALIZED_VIEW);

/**
 * Every relation a measured statement can read. Write statistics would name
 * only the tables a seed touched, but they are flushed per connection and
 * asynchronously, so on a pool they can miss a table; listing all of them
 * keeps the maintained set a function of the schema alone.
 */
const publicRelations = async (database: GatedTestDb) => {
  const rows = executedRows(
    await database.execute(sql`SELECT c.relname AS name, c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN (${RELATION_KIND.TABLE}, ${RELATION_KIND.MATERIALIZED_VIEW})
      ORDER BY c.relname`),
  );
  if (!rows.every(isRelation)) {
    return panic("Could not decode public relations");
  }
  return rows;
};

/**
 * Runs a seed, then freezes the physical state measurements read: autovacuum
 * off for the fixture database's lifetime and a VACUUM (ANALYZE) of every
 * relation, so page counts depend on code and fixture, not vacuum timing.
 */
export const withSeededTableMaintenance = async <T>(
  database: GatedTestDb,
  seed: () => Promise<T>,
) => {
  const value = await seed();
  for (const { name, kind } of await publicRelations(database)) {
    // db-await-in-loop: PostgreSQL requires one relation per VACUUM statement.
    await database.execute(
      kind === RELATION_KIND.TABLE
        ? sql`ALTER TABLE ${sql.identifier(name)} SET (autovacuum_enabled = false)`
        : sql`ALTER MATERIALIZED VIEW ${sql.identifier(name)} SET (autovacuum_enabled = false)`,
    );
    await database.execute(sql`VACUUM (ANALYZE) ${sql.identifier(name)}`);
  }
  return value;
};
