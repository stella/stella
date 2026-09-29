import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { withSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  configureReadTransaction,
  EXTERNAL_PUBLIC_LAW_READ_GUARDS,
} from "@/api/lib/public-law-read-db";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/** The real PostgreSQL settings must match the public-read transaction guard. */

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

test("the public read is read-only and bounded", async () => {
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

test("nested query budgets restore the prior tighter budget", async () => {
  await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    expect(await readSetting(tx, "statement_timeout")).toBe("30s");
    await withSharedStatementTimeout(tx, 3000, async () => {
      expect(await readSetting(tx, "statement_timeout")).toBe("3s");
      await withSharedStatementTimeout(tx, 10_000, async () => {
        expect(await readSetting(tx, "statement_timeout")).toBe("3s");
      });
      expect(await readSetting(tx, "statement_timeout")).toBe("3s");
    });
    expect(await readSetting(tx, "statement_timeout")).toBe("30s");
  });
});

test("a failed nested read restores its budget when the transaction remains usable", async () => {
  await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    await expect(
      withSharedStatementTimeout(tx, 3000, async () => {
        expect(await readSetting(tx, "statement_timeout")).toBe("3s");
        throw new Error("nested read failed");
      }),
    ).rejects.toThrow("nested read failed");
    expect(await readSetting(tx, "statement_timeout")).toBe("30s");
  });
});

test("a cancelled statement keeps its original error if its transaction rejects restoration", async () => {
  const timeout = new Error("statement timed out");
  let executions = 0;
  const transaction = {
    execute: async () => {
      executions += 1;
      if (executions === 1) {
        return [{ statement_timeout: "30s" }];
      }
      if (executions === 2) {
        return [];
      }
      throw new Error("transaction is aborted");
    },
  };
  await expect(
    withSharedStatementTimeout(transaction, 3000, async () => {
      throw timeout;
    }),
  ).rejects.toBe(timeout);
  expect(executions).toBe(3);
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
