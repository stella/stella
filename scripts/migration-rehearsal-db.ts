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
//
//   bun scripts/migration-rehearsal-db.ts contend
//     Writes to the high-volume corpus tables the way production's workers
//     do while an upgrade runs: one row per table updated in a transaction
//     held open for a moment, over and over, until the process is killed.
//     A DDL statement that waits a single short lock_timeout for ACCESS
//     EXCLUSIVE on such a table fails against this, as it does in
//     production; one that retries wins a gap. Prints CONTENTION_HELD_LINE
//     once the first transaction holds its locks, so a caller can wait for
//     that before it starts the work under test, and exits non-zero if a
//     write fails. Never run this against a database that matters.

import { SQL } from "bun";

const COMMANDS = ["assert-empty", "contend", "digest"] as const;
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

/** How long each contending transaction holds its row lock. */
const CONTENTION_HOLD_MS = 1500;
/** Printed once the first contending transaction holds its locks. */
const CONTENTION_HELD_LINE = "contending: locks held";
/** Tables production's workers write to continuously, with a no-op touch. */
const CONTENDED_UPDATES = [
  "UPDATE case_law_decisions SET updated_at = updated_at WHERE id = (SELECT id FROM case_law_decisions ORDER BY id LIMIT 1)",
  "UPDATE case_law_citations SET resolution_rule_id = resolution_rule_id WHERE id = (SELECT id FROM case_law_citations ORDER BY id LIMIT 1)",
] as const;

/**
 * One held transaction after another, until the process is killed.
 * Recursive rather than a loop with an awaited body: each transaction must
 * commit before the next begins, so the sequencing is structural. The
 * readiness line goes out after the first transaction's updates have
 * acquired their locks, never before.
 */
const contendForever = async (
  connection: SQL,
  announced = false,
): Promise<never> => {
  await connection.unsafe(`BEGIN; ${CONTENDED_UPDATES.join("; ")};`);
  if (!announced) {
    console.log(CONTENTION_HELD_LINE);
  }
  await Bun.sleep(CONTENTION_HOLD_MS);
  await connection.unsafe("COMMIT");
  return await contendForever(connection, true);
};

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

  if (command === "contend") {
    await contendForever(client);
  }

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
