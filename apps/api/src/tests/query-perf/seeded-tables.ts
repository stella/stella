import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

const RELATION_KIND = {
  TABLE: "r",
  MATERIALIZED_VIEW: "m",
} as const;

type Relation = {
  name: string;
  kind: (typeof RELATION_KIND)[keyof typeof RELATION_KIND];
  /** False for a materialized view created WITH NO DATA, which cannot be read. */
  populated: boolean;
};

const isRelation = (row: unknown): row is Relation =>
  isRecord(row) &&
  typeof row["name"] === "string" &&
  typeof row["populated"] === "boolean" &&
  (row["kind"] === RELATION_KIND.TABLE ||
    row["kind"] === RELATION_KIND.MATERIALIZED_VIEW);

/**
 * Every relation a measured statement can read. Write statistics would name
 * only the tables a seed touched, but they are flushed per connection and
 * asynchronously, so on a pool they can miss a table; listing all of them
 * keeps the maintained set a function of the schema alone.
 */
const publicRelations = async (database: GatedTestDb) => {
  const rows = executedRows(
    await database.execute(sql`SELECT c.relname AS name, c.relkind AS kind,
        c.relispopulated AS populated
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

const hasRows = async (database: GatedTestDb, name: string) => {
  const row = executedRows(
    await database.execute(
      sql`SELECT EXISTS (SELECT 1 FROM ${sql.identifier(name)}) AS populated`,
    ),
  ).at(0);
  return isRecord(row) && row["populated"] === true;
};

/**
 * Runs a seed, then freezes the physical state measurements read: autovacuum
 * off for the fixture database's lifetime and a VACUUM (ANALYZE) of every
 * relation holding rows, so page counts depend on code and fixture, not vacuum
 * timing. An empty relation keeps no statistics, as in a fresh database:
 * analyzed as empty, the planner would scan it sequentially, which no
 * production-sized table would get.
 */
export const withSeededTableMaintenance = async <T>(
  database: GatedTestDb,
  seed: () => Promise<T>,
) => {
  const value = await seed();
  for (const { name, kind, populated } of await publicRelations(database)) {
    // db-await-in-loop: PostgreSQL requires one relation per VACUUM statement.
    await database.execute(
      kind === RELATION_KIND.TABLE
        ? sql`ALTER TABLE ${sql.identifier(name)} SET (autovacuum_enabled = false)`
        : sql`ALTER MATERIALIZED VIEW ${sql.identifier(name)} SET (autovacuum_enabled = false)`,
    );
    if (populated && (await hasRows(database, name))) {
      await database.execute(sql`VACUUM (ANALYZE) ${sql.identifier(name)}`);
    }
  }
  return value;
};
