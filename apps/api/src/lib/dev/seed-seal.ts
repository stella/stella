import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";

// Written by reading or browsing the stack, never by content a person or an
// agent enters: session refresh, key use, audit trails, job bookkeeping. An
// audited write also changes the content table it touched, so ignoring the
// trail hides nothing. Any other table that changes blocks attachment.
const OPERATIONAL_TABLES = new Set([
  "public.apikey",
  "public.audit_logs",
  "public.scheduler_job_runs",
  "public.scheduler_jobs",
  "public.session",
]);

export type Seal = Record<string, string>;

export const readTableDigests = async (
  db: Pick<typeof rootDb, "select">,
): Promise<Seal> => {
  const tables = await db
    .select({
      schema: sql<string>`table_schema`,
      name: sql<string>`table_name`,
    })
    .from(sql`information_schema.tables`).where(sql`
    table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  `);
  const digests = new Map<string, string>();
  for (const { schema, name } of tables) {
    const table = `${schema}.${name}`;
    if (OPERATIONAL_TABLES.has(table)) {
      continue;
    }
    // Row order is not stable, so rows are hashed and the hashes sorted.
    const [row] = await db
      .select({
        digest: sql<string>`count(*) || ':' || md5(coalesce(
        string_agg(md5(t::text), '' ORDER BY md5(t::text)), ''
      ))`,
      })
      .from(sql`${sql.identifier(schema)}.${sql.identifier(name)} AS t`);
    digests.set(table, row?.digest ?? panic(`No digest for ${table}`));
  }
  return Object.fromEntries(
    [...digests].toSorted(([left], [right]) => {
      if (left === right) {
        return 0;
      }
      return left < right ? -1 : 1;
    }),
  );
};

export const changedSealTables = (sealed: Seal, current: Seal): string[] =>
  [...new Set([...Object.keys(sealed), ...Object.keys(current)])]
    .filter((table) => sealed[table] !== current[table])
    .toSorted();
