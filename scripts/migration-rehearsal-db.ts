#!/usr/bin/env bun
// Database-side helpers for scripts/rehearse-migration-upgrade.sh.
//
//   bun scripts/migration-rehearsal-db.ts assert-empty
//     Exits non-zero unless the database holds no user tables: the rehearsal
//     seeds millions of synthetic rows and applies migrations, so a populated
//     database, real or stale, must never be its target.
//
//   bun scripts/migration-rehearsal-db.ts digest
//     Prints one line that changes when the upgrade's observable state does:
//     the applied migration hashes, the validity of every CHECK constraint,
//     and row-state digests of the corpus tables an online repair rewrites.
//     The rehearsal compares it across the rerun to prove the fixed point.

import { SQL } from "bun";

const COMMANDS = ["assert-empty", "digest"] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string | undefined): value is Command =>
  COMMANDS.some((command) => command === value);

const command = process.argv[2];
if (!isCommand(command)) {
  console.error(
    `Usage: bun scripts/migration-rehearsal-db.ts <${COMMANDS.join("|")}>`,
  );
  process.exit(2);
}

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

type CountRow = { count: number };
type DigestRow = { digest: string };

const client = new SQL({ url, max: 1, connectionTimeout: 30 });

const digestOf = async (query: string): Promise<string> => {
  const rows: DigestRow[] = await client.unsafe(query);
  const row = rows.at(0);
  if (row === undefined || typeof row.digest !== "string") {
    throw new TypeError(`digest query returned no digest: ${query}`);
  }
  return row.digest;
};

try {
  await client.unsafe("SET statement_timeout = '10min'");

  if (command === "assert-empty") {
    const rows: CountRow[] = await client.unsafe(
      "SELECT count(*)::int AS count FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    );
    const count = rows.at(0)?.count ?? Number.NaN;
    if (count !== 0) {
      console.error(
        `Refusing to rehearse against a database that already holds ${String(count)} table(s); the rehearsal needs an empty, disposable database.`,
      );
      process.exit(1);
    }
    console.log("database is empty");
  } else {
    const migrations = await digestOf(
      "SELECT md5(coalesce(string_agg(hash, ',' ORDER BY hash), '')) AS digest FROM drizzle.__drizzle_migrations",
    );
    const constraints = await digestOf(
      "SELECT md5(coalesce(string_agg(conname || ':' || convalidated::text, ',' ORDER BY conname), '')) AS digest FROM pg_catalog.pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace",
    );
    const decisions = await digestOf(
      "SELECT md5(coalesce(string_agg(id::text || '|' || coalesce(decision_date::text, '') || '|' || coalesce(indexed_hash, ''), ',' ORDER BY id), '')) AS digest FROM case_law_decisions",
    );
    const citations = await digestOf(
      "SELECT md5(coalesce(string_agg(id::text || '|' || resolution_status || '|' || coalesce(cited_decision_id::text, '') || '|' || coalesce(resolution_rule_id, ''), ',' ORDER BY id), '')) AS digest FROM case_law_citations",
    );
    console.log(
      `migrations=${migrations} constraints=${constraints} decisions=${decisions} citations=${citations}`,
    );
  }
} finally {
  await client.end();
}
