import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { executedRows } from "@/api/lib/db/executed-rows";
import {
  configureReadTransaction,
  EXTERNAL_PUBLIC_LAW_READ_GUARDS,
} from "@/api/lib/public-law-read-db";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The guards a public read runs under arrive in one statement. Proving their
 * effect against a real PostgreSQL is what keeps that statement honest: a
 * read-only transaction that is not read-only, or a timeout that never took,
 * would otherwise look exactly like the cheaper setup it replaced.
 */

const readSetting = async (
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  setting: string,
): Promise<string> => {
  const [row] = executedRows(
    await tx.execute(sql`SELECT current_setting(${setting}) AS value`),
  );
  return isRecord(row) ? String(row["value"]) : "";
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

test("one statement makes the transaction read-only and bounds it", async () => {
  const settings = await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    return {
      readOnly: await readSetting(tx, "transaction_read_only"),
      statementTimeout: await readSetting(tx, "statement_timeout"),
      lockTimeout: await readSetting(tx, "lock_timeout"),
      idleTimeout: await readSetting(tx, "idle_in_transaction_session_timeout"),
    };
  });

  expect(settings).toEqual({
    readOnly: "on",
    statementTimeout: "30s",
    lockTimeout: "1s",
    idleTimeout: "30s",
  });
});

test("repeatable read binds the snapshot and stays read-only", async () => {
  const isolation = await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "repeatable-read",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    return {
      level: await readSetting(tx, "transaction_isolation"),
      readOnly: await readSetting(tx, "transaction_read_only"),
    };
  });

  expect(isolation).toEqual({ level: "repeatable read", readOnly: "on" });
});

test("a configured transaction refuses to write", async () => {
  const write = db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    await tx.execute(
      sql`CREATE TEMPORARY TABLE public_law_write_probe (id int)`,
    );
  });

  const failure = await write.then(
    () => null,
    (error: unknown) => error,
  );

  expect(isRecord(failure)).toBe(true);
  expect(String(isRecord(failure) ? failure["cause"] : "")).toContain(
    "read-only transaction",
  );
});

test("the guards last no longer than the transaction", async () => {
  await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
  });

  expect(await readSetting(db, "transaction_read_only")).toBe("off");
  expect(await readSetting(db, "statement_timeout")).not.toBe("30s");
});
