/**
 * Seal a seeded local stack, then tell whether it still holds only seeded
 * content. Screenshots of a local stack may be attached to public pull
 * requests only while it does: anything created after the seed (an upload, a
 * typed name, a chat) could carry private data.
 *
 * The seal is a per-table fingerprint of every row, taken right after the
 * seed. Tables that change merely because the app is used (sessions, audit
 * events, queues) are ignored; everything else must match. The dev runner
 * seals only a database that was fresh or still matched its seal before the
 * seed ran, so rows entered earlier can never become part of the baseline.
 *
 * `check` prints one of:
 *   {"status":"fresh"}      no user exists yet, so nothing was entered
 *   {"status":"pristine"}   every table matches the seal
 *   {"status":"modified","tables":[...]}
 *   {"status":"unsealed"}   no seal file
 *
 * Usage:
 *   bun scripts/seed-seal.ts write <seal.json>
 *   bun scripts/seed-seal.ts check <seal.json>
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";

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

const MODES = ["write", "check"] as const;
type Mode = (typeof MODES)[number];

type Seal = Record<string, string>;

const isMode = (value: string | undefined): value is Mode =>
  MODES.some((mode) => mode === value);

const isSeal = (value: unknown): value is Seal =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((digest) => typeof digest === "string");

const readTableDigests = async (): Promise<Seal> => {
  const db = openMaintenanceDb({ readOnly: true });
  const tables = await db.execute<{ schema: string; name: string }>(sql`
    SELECT table_schema AS schema, table_name AS name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1, 2
  `);
  const digests: Seal = {};
  for (const { schema, name } of tables) {
    const table = `${schema}.${name}`;
    if (OPERATIONAL_TABLES.has(table)) {
      continue;
    }
    // Row order is not stable, so rows are hashed and the hashes sorted.
    const [row] = await db.execute<{ digest: string }>(sql`
      SELECT count(*) || ':' || md5(coalesce(
        string_agg(md5(t::text), '' ORDER BY md5(t::text)), ''
      )) AS digest
      FROM ${sql.identifier(schema)}.${sql.identifier(name)} AS t
    `);
    digests[table] = row?.digest ?? panic(`No digest for ${table}`);
  }
  return digests;
};

const [mode, sealPath] = process.argv.slice(2);
if (!isMode(mode) || sealPath === undefined) {
  console.error("Usage: seed-seal.ts <write|check> <seal.json>");
  process.exit(2);
}

// Every account-bound row needs a user, so a database without one has
// received no content from anyone.
const isFresh = async () => {
  const [row] = await openMaintenanceDb({ readOnly: true }).execute<{
    fresh: boolean;
  }>(sql`SELECT NOT EXISTS (SELECT 1 FROM "user") AS fresh`);
  return row?.fresh === true;
};

const digests = await readTableDigests();
switch (mode) {
  case "write": {
    mkdirSync(path.dirname(sealPath), { recursive: true });
    writeFileSync(sealPath, `${JSON.stringify(digests, null, 2)}\n`);
    break;
  }
  case "check": {
    if (await isFresh()) {
      console.log(JSON.stringify({ status: "fresh" }));
      break;
    }
    if (!existsSync(sealPath)) {
      console.log(JSON.stringify({ status: "unsealed" }));
      break;
    }
    const sealed: unknown = JSON.parse(readFileSync(sealPath, "utf-8"));
    if (!isSeal(sealed)) {
      panic(`${sealPath} is not a seal`);
    }
    const tables = [
      ...new Set([...Object.keys(sealed), ...Object.keys(digests)]),
    ]
      .filter((table) => sealed[table] !== digests[table])
      .toSorted();
    console.log(
      JSON.stringify(
        tables.length === 0
          ? { status: "pristine" }
          : { status: "modified", tables },
      ),
    );
    break;
  }
  default: {
    mode satisfies never;
    panic(`Unhandled seal mode: ${String(mode)}`);
  }
}
process.exit(0);
