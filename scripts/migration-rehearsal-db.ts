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
//     do while an upgrade runs: two sessions, each updating one row per
//     table in a transaction held open for several seconds, over and over,
//     staggered by half a hold, until the process is killed. Each
//     transaction holds the corpus schema lane shared, tried and backed
//     off exactly as createIngestionDb does, so an upgrade that takes the
//     lane exclusive drains them and runs its DDL against an idle table.
//     With two holders out of phase there is never a moment when both end
//     within a short wait, so an upgrade that skipped the lane and only
//     waited briefly for ACCESS EXCLUSIVE could not win, as in production.
//     Prints CONTENTION_HELD_LINE once both sessions hold their locks, so a
//     caller can wait for that before it starts the work under test, and
//     exits non-zero if a write fails. Never run this against a database
//     that matters.

import { panic } from "better-result";
import { SQL } from "bun";

import { runUnderCorpusSchemaLane } from "../apps/api/src/db/corpus-schema-lane";

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

/**
 * How long each contending transaction holds its row locks: longer than a
 * short DDL lock wait, the way the corpus workers' batches are.
 */
const CONTENTION_HOLD_MS = 5000;
/**
 * Two holders half a hold out of phase: whenever one is about to commit the
 * other has half a hold left, so a wait shorter than that never finds both
 * gone at once.
 */
const CONTENDERS = 2;
/** Printed once every contending session holds its locks. */
const CONTENTION_HELD_LINE = "contending: locks held";
/** Tables production's workers write to continuously, with a no-op touch. */
const CONTENDED_UPDATES = [
  "UPDATE case_law_decisions SET updated_at = updated_at WHERE id = (SELECT id FROM case_law_decisions ORDER BY id LIMIT 1)",
  "UPDATE case_law_citations SET resolution_rule_id = resolution_rule_id WHERE id = (SELECT id FROM case_law_citations ORDER BY id LIMIT 1)",
] as const;

type RawTransaction = { execute: (query: string) => Promise<unknown> };

/** One session's `BEGIN`/`COMMIT` pair as the lane helper's database. */
const rawTransactions = (connection: SQL) => ({
  transaction: async <TResult>(
    fn: (tx: RawTransaction) => Promise<TResult>,
  ): Promise<TResult> => {
    await connection.unsafe("BEGIN");
    try {
      const result = await fn({
        execute: async (query) => await connection.unsafe(query),
      });
      await connection.unsafe("COMMIT");
      return result;
    } catch (error: unknown) {
      await connection.unsafe("ROLLBACK");
      throw error;
    }
  },
});

/**
 * One held transaction after another on one session, until the process is
 * killed. Recursive rather than a loop with an awaited body: each
 * transaction must commit before the next begins, so the sequencing is
 * structural. `onHeld` fires once, after the first transaction's updates
 * have acquired their locks, never before.
 */
const contendForever = async (
  connection: SQL,
  onHeld: (() => void) | null,
): Promise<never> => {
  await runUnderCorpusSchemaLane({
    database: rawTransactions(connection),
    work: async () => {
      await connection.unsafe(CONTENDED_UPDATES.join("; "));
      onHeld?.();
      await Bun.sleep(CONTENTION_HOLD_MS);
    },
  });
  return await contendForever(connection, null);
};

/** Every contender, staggered, announced together once all hold. */
const contendWithAll = async (databaseUrl: string): Promise<never> => {
  let held = 0;
  const onHeld = () => {
    held += 1;
    if (held === CONTENDERS) {
      console.log(CONTENTION_HELD_LINE);
    }
  };
  const chains = Array.from({ length: CONTENDERS }, async (_, index) => {
    await Bun.sleep((CONTENTION_HOLD_MS * index) / CONTENDERS);
    const connection = new SQL({
      url: databaseUrl,
      max: 1,
      connectionTimeout: 30,
    });
    return await contendForever(connection, onHeld);
  });
  await Promise.all(chains);
  return panic("contenders never return");
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
    await contendWithAll(url);
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
